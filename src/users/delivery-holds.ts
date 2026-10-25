// What a delivery hold holds, read from the user's store (issue #2775 part 7, design.md "Part 6: interventions and the
// delivery hold"): a job's hold for yolo mode's merge, and the pull requests of a repository for the batch runner and the
// stable move. Read from the hold and release events at each ask, so a hold counts from its event on.
import { HOLD_EVENTS, heldJobs, heldNumbers, holdWhy } from '../domain/track-interventions.ts';
import type { UserStore } from '../domain/store.ts';

/** How many of the newest hold and release events are read: far more than the holds a person keeps open at once. */
const HOLD_READ = 2000;

/** Why a hold holds job `jobId`'s change, or undefined. */
export function jobHoldWhy(store: Pick<UserStore, 'events'>, jobId: string): string | undefined {
  const hold = heldJobs(store.events.recent(HOLD_READ, [...HOLD_EVENTS], jobId)).get(jobId);
  return hold && holdWhy(hold);
}

/** The pull requests of `repo` whose change a hold holds: each held job's pull request, as the job names it, else as its track does. */
export function heldPullRequests(store: Pick<UserStore, 'events' | 'jobs' | 'keptTracks'>, repo: string): Set<number> {
  const urls = [...heldJobs(store.events.recent(HOLD_READ, [...HOLD_EVENTS])).keys()].flatMap((id) => {
    const named = (store.jobs.get(id)?.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
    const url = typeof named === 'string' ? named : store.keptTracks.get(id)?.marks.pr;
    return url === undefined ? [] : [url];
  });
  return heldNumbers(urls, repo);
}
