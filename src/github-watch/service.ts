// GitHub watches (issue #427, design.md "GitHub watches"): one user's watches, one per pointed job that has not ended,
// each polling its item through the poll schedule (issue #436: rounds of the user's interval, in batches of the shared
// rate limiter's batch size). A poll compares what it read with the stored snapshot: a change is one
// `github_watch.changed`, written with the new snapshot in one transaction; no change writes the poll's time only. A new
// watch polls at once for its first snapshot, which emits nothing. The pointed jobs are followed through their events, so
// a new one is watched and an ended one is not, with no restart. A change of the interval is saved, is
// `github_watch.settings_changed`, and starts the rounds again at once on the new interval.
import {
  githubWatchChanges, githubWatchSettingsOf, watched, type GitHubWatch, type GitHubWatchSettings, type GitHubWatchView,
} from '../domain/github-watch.ts';
import type { PointedJob } from '../domain/pointed-jobs.ts';
import type { UserStore } from '../domain/ports.ts';
import { githubLimiter } from '../github-limiter/limiter.ts';
import { createPollSchedule, type PollSchedule } from '../github-limiter/poll-schedule.ts';
import type { WatchGitHub } from './github.ts';

export interface GitHubWatches {
  view(): GitHubWatchView;
  /** Saves and applies the settings; the same values change nothing and record nothing. */
  change(settings: GitHubWatchSettings, by: string): Promise<GitHubWatchView>;
  /** Polls one watch now (the schedule's own poll); a watch of no pointed job, or one that ended, does nothing. */
  poll(pointedJob: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface GitHubWatchesOptions {
  store: Pick<UserStore, 'pointedJobs' | 'githubWatches' | 'settings' | 'events' | 'tx'>;
  /** The person's own GitHub connection, or why there is none. */
  github(): WatchGitHub | { problem: string };
  now(): string;
  log(line: string): void;
  /** Polls that run at once in one batch; default: the shared rate limiter's. */
  batchSize?(): number;
}

const POINTED_JOB_EVENTS = new Set(['pointed_job.created', 'pointed_job.status_changed']);

export function createGitHubWatches(o: GitHubWatchesOptions): GitHubWatches {
  const settings = (): GitHubWatchSettings => githubWatchSettingsOf(o.store.settings.getGitHubWatch());
  const polling = new Map<string, Promise<void>>();
  let schedule: PollSchedule | undefined;
  /** The pointed jobs the schedule holds. */
  let held = new Set<string>();
  let unsubscribe: (() => void) | undefined;

  const newSchedule = (): PollSchedule => createPollSchedule({
    intervalMs: () => settings().intervalSeconds * 1000,
    batchSize: o.batchSize ?? (() => githubLimiter.settings().batchSize),
    onError: (id, err) => o.log(`hopper: GitHub watch of pointed job ${id}: ${err instanceof Error ? err.message : String(err)}`),
  });

  async function pollOnce(job: PointedJob): Promise<void> {
    const before = o.store.githubWatches.get(job.id);
    const base: GitHubWatch = { ...before, pointedJob: job.id, repo: job.repo, pointer: job.pointer };
    const gh = o.github();
    let snapshot;
    try {
      if ('problem' in gh) throw new Error(gh.problem);
      snapshot = await gh.snapshot(job.repo, job.pointer);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (error !== before?.error) o.log(`hopper: GitHub watch of ${job.repo}#${job.pointer.number}: ${error}`);
      o.store.githubWatches.put({ ...base, error });
      return;
    }
    const at = o.now();
    const changes = before?.snapshot && githubWatchChanges(before.snapshot, snapshot);
    const { error: _, ...kept } = base;
    o.store.tx(() => {
      o.store.githubWatches.put({ ...kept, snapshot, polledAt: at, ...(changes || !before?.snapshot ? { changedAt: at } : {}) });
      if (changes) o.store.events.append({ type: 'github_watch.changed', data: { pointedJob: job.id, repo: job.repo, pointer: job.pointer, changes } });
    });
  }

  function poll(id: string): Promise<void> {
    const job = o.store.pointedJobs.get(id);
    if (!job || !watched(job)) { schedule?.remove(id); held.delete(id); return Promise.resolve(); }
    // One poll of a watch at a time: the first poll of a new watch and its round never compare against one snapshot twice.
    const running = polling.get(id);
    if (running) return running;
    const p = pollOnce(job).finally(() => polling.delete(id));
    polling.set(id, p);
    return p;
  }

  /** The schedule holds every pointed job that has not ended; one new to it polls at once. */
  function follow(): void {
    if (!schedule) return;
    const open = new Set(o.store.pointedJobs.list().filter(watched).map((j) => j.id));
    for (const id of open) {
      if (held.has(id)) continue;
      held.add(id);
      schedule.add(id, () => poll(id));
      if (!o.store.githubWatches.get(id)?.snapshot) void poll(id).catch(() => undefined);
    }
    for (const id of held) if (!open.has(id)) { schedule.remove(id); held.delete(id); }
  }

  function begin(): void {
    schedule = newSchedule();
    held = new Set();
    follow();
    schedule.start();
  }

  return {
    view: () => ({
      settings: settings(),
      watches: o.store.pointedJobs.list().filter(watched).map((j) => o.store.githubWatches.get(j.id) ?? { pointedJob: j.id, repo: j.repo, pointer: j.pointer }),
    }),
    async change(next, by) {
      const from = settings(), to = githubWatchSettingsOf(next);
      if (from.intervalSeconds !== to.intervalSeconds) {
        o.store.tx(() => {
          o.store.settings.setGitHubWatch(to);
          o.store.events.append({ type: 'github_watch.settings_changed', data: { from, to, by } });
        });
        // Applied at once: the rounds start again on the new interval, the first now.
        if (schedule) {
          const old = schedule;
          schedule = undefined;
          await old.stop();
          begin();
        }
      }
      return this.view();
    },
    poll,
    start() {
      if (unsubscribe) return;
      unsubscribe = o.store.events.subscribe((e) => { if (POINTED_JOB_EVENTS.has(e.type)) follow(); });
      begin();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      const s = schedule;
      schedule = undefined;
      await s?.stop();
      await Promise.all(polling.values());
    },
  };
}
