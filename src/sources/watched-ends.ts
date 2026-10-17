// The items jobs' waits name (issue #1508, design.md "Watched items"), the sync loop's half: at each sync of a source, the
// items its jobs on their own wait name (`watchedItems`) are asked of it (`JobSource.endedWatched`). A job all of whose items
// ended — though they ended before the wait began — is recorded so (`job.waited_items_ended`), and the engine wakes it on that
// event (`settledBy`). Once per wait; and a job woken so that waits again on the very same items is not woken for them again,
// so a wait that names an item that ended long ago does not wake at every sync. Kept in memory: after a restart, such a job
// is woken once more. Not while the source is removed; a throw is logged and asked again at the next sync.
import type { JobSource, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { watchedItems, watchedOf, watchKey } from '../domain/watched-items.ts';

export function watchedEnds(store: Pick<UserStore, 'jobs' | 'events'>) {
  /** Per job: the items it was last woken for. */
  const woken = new Map<string, string>();
  const keyOf = (j: Job) => watchedOf(j).map(watchKey).sort().join(' ');

  /** Read the items the waits of `listed`, the source's jobs, name; record each job whose items all ended. */
  return async function ends(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.endedWatched) return;
    const jobs = listed.map((j) => store.jobs.get(j.id) ?? j).filter((j) => j.status === 'waiting_on' && woken.get(j.id) !== keyOf(j));
    const watched = watchedItems(jobs);
    if (watched.length === 0) return;
    try {
      const ended = new Map((await source.endedWatched(watched.map((w) => w.ref))).map((e) => [watchKey(e.ref), e]));
      for (const j of jobs) {
        const now = store.jobs.get(j.id);
        if (now?.status !== 'waiting_on' || now.wait?.since !== j.wait?.since) continue;
        const refs = watchedOf(now);
        const ends = refs.map((r) => ended.get(watchKey(r)));
        if (refs.length === 0 || ends.some((e) => !e)) continue;
        woken.set(j.id, keyOf(now));
        store.events.append({ type: 'job.waited_items_ended', jobId: j.id, data: { items: ends.map((e) => ({ url: e!.url, state: e!.state })) } });
      }
    } catch (e) {
      console.warn(`hopper: ${source.name}: reading the items jobs wait on failed, asked again at the next sync: ${(e as Error).message}`);
    }
  };
}
