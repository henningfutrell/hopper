// The sync watch (issue #967): tending starts on GitHub's events, not only on each sync. Every `WATCH_MS` between syncs,
// each source that can say (`JobSource.moved`) is asked whether a pull request or a branch of the repositories whose pull
// requests its jobs follow or tend moved since it was asked last. Moved: a sync of it at once, so a merged or closed pull
// request is reconciled and a moved base is tended in seconds, not at the next sync. A source that syncs now, is removed,
// or follows nothing is not asked; one ask per source at a time. A failed ask is no sync: it is logged once when it
// changes, and the next tick asks again. Nothing here acts on a job: the sync does.
// A pull request merged or closed (`onEvent`): the base of the others moved, so its source syncs again at once — after the
// sync that recorded it (`again`), or now when it does not sync (a person's Merge now).
import { following, type DomainEvent, type Job } from '../domain/types.ts';
import type { Slot } from './sync-slots.ts';

/** How often a source is asked whether its repositories moved. */
export const WATCH_MS = 15_000;

/** A pull request ended: the base of the others moved, or a card goes. */
const PR_ENDED = new Set(['job.pull_request_merged', 'job.pull_request_closed']);

export interface SyncWatchOptions {
  slots(): Iterable<Slot>;
  jobsOf(slot: Slot): Job[];
  /** Start a sync of the slot now. */
  sync(slot: Slot): void;
  watchMs: number;
}

/** Following a pull request, or handed to a tend job that works on it: its repository is watched. */
const watched = (j: Job): boolean => following(j) || (j.sourceState?.source as { follow?: unknown } | undefined)?.follow === 'tended';

/** The repositories whose pull requests the slot's jobs follow or tend, each once, as first named. */
export function watchedRepos(jobs: Job[]): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    const repo = j.source?.repo;
    if (repo !== undefined && watched(j) && !out.some((r) => r.toLowerCase() === repo.toLowerCase())) out.push(repo);
  }
  return out;
}

export function createSyncWatch(o: SyncWatchOptions) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function ask(slot: Slot): Promise<void> {
    const moved = slot.source.moved?.bind(slot.source);
    if (!moved || slot.removed || slot.watching || slot.status.syncing) return;
    const repos = watchedRepos(o.jobsOf(slot));
    if (repos.length === 0) return;
    slot.watching = true;
    try {
      const yes = await moved(repos);
      delete slot.watchError;
      if (yes && running && !slot.status.syncing) o.sync(slot);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== slot.watchError) console.warn(`hopper: source ${slot.source.name}: asking GitHub what moved failed, asked again in ${o.watchMs / 1000} s: ${message}`);
      slot.watchError = message;
    } finally {
      slot.watching = false;
    }
  }

  function tick(): void {
    if (!running) return;
    for (const slot of o.slots()) void ask(slot);
    timer = setTimeout(tick, o.watchMs);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      timer = setTimeout(tick, o.watchMs);
    },
    stop(): void {
      running = false;
      clearTimeout(timer);
    },
    /** An event of a job of `slot`: a pull request that ended syncs its source again at once. */
    onEvent(e: DomainEvent, slot: Slot | undefined): void {
      if (!running || !slot || slot.removed || !PR_ENDED.has(e.type)) return;
      if (slot.status.syncing) { slot.again = true; return; }
      // Listeners fire inside append; never start a sync from there.
      setImmediate(() => { if (running && !slot.status.syncing) o.sync(slot); });
    },
  };
}
