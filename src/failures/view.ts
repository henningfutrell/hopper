// What the Failures view reads (issue #509): how many failed jobs are left (issue #517), the hand-offs waiting on a
// person and those closed in the last day (issue #516), the open problems and those resolved in the last day, the
// newest assessed failures nothing settled (issue #529), the profile — and, on each problem and failure, whether the daemon takes each action now
// and why not. The routes refuse with the same reasons, so the view offers only what is taken.
import type { UserStore } from '../domain/ports.ts';
import { highFirst, jobPriorityTag, type Allowed, type FailureCounts, type FailureRecord, type FailureSettings, type FailuresView, type Handoff, type HandoffView, type Job, type Problem, type ProblemView } from '../domain/types.ts';
import { knownCauses } from './causes.ts';
import { SETTLED } from './handoff.ts';
import { profileOf } from './profile.ts';

const DAY_MS = 86_400_000;
const PROFILE_DAYS = 14;
const RECENT = 50;
const OK: Allowed = { ok: true };
const no = (why: string): Allowed => ({ ok: false, why });

type Reads = Pick<UserStore, 'failures' | 'problems' | 'jobs'>;

/** The newer job of its item, when the job is not its item's newest. */
export function newerOf(store: Pick<UserStore, 'jobs'>, job: Job): string | undefined {
  const newest = job.source ? store.jobs.getBySourceKey(job.source.key) : undefined;
  return newest && newest.id !== job.id ? newest.id : undefined;
}

/** How many failed jobs are left (issue #517): not assessed yet, and handed off to a person (open hand-offs). */
export function countsOf(store: Pick<UserStore, 'jobs' | 'handoffs'>): FailureCounts {
  return {
    unassessed: store.jobs.list({ status: ['failed'], unassessed: true }).length,
    needsPerson: store.handoffs.list({ status: 'open', limit: 1_000_000 }).length,
  };
}

/** Whether the job can run again: it exists, has a source, and is the newest job of its item. */
export function newestOfItem(store: Pick<UserStore, 'jobs'>, jobId: string): Allowed {
  const job = store.jobs.get(jobId);
  if (!job) return no('its job is gone');
  if (!job.source) return no('its job has no source to run it again');
  if (store.jobs.getBySourceKey(job.source.key)?.id !== jobId) return no('a newer job of its item exists');
  return OK;
}

/** The records of a problem whose jobs wait on its release, and can run again. */
export function releasable(store: Reads, problemId: string): FailureRecord[] {
  return store.failures.list({ problemId }).filter((r) => r.outcome === 'held' && r.pending === undefined && newestOfItem(store, r.jobId).ok);
}

/** Whether a person may run a failure's job again now. */
export function recordRetry(store: Reads, r: FailureRecord): Allowed {
  if (r.pending) return no(r.pending === 'retry' ? 'it runs again by itself' : 'it is being run again');
  if (r.outcome === 'retried' || r.outcome === 'redirected' || r.outcome === 'released' || r.outcome === 'superseded') return no('already run again');
  if (r.outcome === 'item_closed') return no('its item is closed');
  if (r.outcome === 'held') return no('it waits on its problem: resolve or release it');
  return newestOfItem(store, r.jobId);
}

/** Whether a person may run a hand-off's job again, or clear it, now. */
export function handoffView(store: Pick<UserStore, 'failures' | 'jobs'>, h: Handoff): HandoffView {
  if (h.status === 'closed') return { ...h, actions: { runAgain: no('already closed'), clear: no('already closed') } };
  const pending = h.recordId ? store.failures.get(h.recordId)?.pending : undefined;
  const runAgain = pending ? no(pending === 'retry' ? 'it runs again by itself' : 'it is being run again') : newestOfItem(store, h.jobId);
  return { ...h, actions: { runAgain, clear: OK } };
}

function problemView(store: Reads, p: Problem): ProblemView {
  const held = releasable(store, p.id);
  return {
    ...p, held: held.map((r) => r.jobId),
    actions: { resolve: p.status === 'open' ? OK : no('already resolved'), release: held.length > 0 ? OK : no('no job is held') },
  };
}

export function viewOf(store: Reads & Pick<UserStore, 'settings' | 'handoffs'>, settings: FailureSettings, now: Date): FailuresView {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const handoffs = [...store.handoffs.list({ status: 'open' }), ...store.handoffs.list({ status: 'closed', closedSince: dayAgo, limit: 50 })];
  const resolved = store.problems.list({ status: 'resolved', limit: 50 }).filter((p) => (p.resolvedAt ?? '') >= dayAgo);
  const since = new Date(now.getTime() - PROFILE_DAYS * DAY_MS).toISOString();
  // Each with its job's live priority (issue #535); the open hand-offs of high-priority jobs first.
  const saved = store.settings.getPriorityLanes();
  const tag = (jobId: string) => jobPriorityTag(store.jobs, saved, jobId);
  return {
    now: now.toISOString(),
    counts: countsOf(store),
    settings,
    handoffs: highFirst(handoffs.map((h) => ({ ...handoffView(store, h), ...tag(h.jobId) })), (h) => h.status === 'open' && h.high === true),
    causes: knownCauses(store.settings.getNamedCauses()),
    problems: [...store.problems.list({ status: 'open' }), ...resolved].map((p) => problemView(store, p)),
    // Nothing waits on a settled one (issue #529): out of the list, still in the profile.
    recent: store.failures.list({ limit: RECENT, notOutcome: [...SETTLED] }).map((r) => ({ ...r, ...tag(r.jobId), actions: { retry: recordRetry(store, r) } })),
    profile: profileOf(store.failures.list({ since, limit: 5000 }), now.toISOString(), { days: PROFILE_DAYS, generalThreshold: settings.groupThreshold }),
  };
}
