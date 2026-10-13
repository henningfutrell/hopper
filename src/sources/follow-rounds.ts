// The in-motion cycle's rounds (issue #985, design.md "The in-motion cycle"): which follows a sync of a source makes. A round
// of every followed pull request each reconcile interval (`allMs`), and whenever it is forced — the first sync, a sync a
// person asked for, the sync after a merge or close —; a round of the pull requests in motion each cycle interval
// (`cycleMs`); none between. A round counts from when it starts, whether its batch read worked or not: a failing GitHub is
// asked again at the next round, never at each sync. No intervals (tests): every sync follows every one. Pure but for the
// slot's two times it keeps.
import type { FollowRound } from './after-done.ts';

/** The cycle interval and the reconcile interval, in ms. */
export interface FollowEvery { cycleMs: number; allMs: number }

/** The events of a pull request that ended: the base of the others moved. */
export const PR_ENDED = new Set(['job.pull_request_merged', 'job.pull_request_closed']);

export function followRound(slot: { followedAt?: number; followedAllAt?: number }, now: number, every: FollowEvery | undefined, forced: boolean): FollowRound {
  const all = forced || !every || slot.followedAllAt === undefined || now - slot.followedAllAt >= every.allMs;
  if (!all && slot.followedAt !== undefined && now - slot.followedAt < every.cycleMs) return 'none';
  slot.followedAt = now;
  if (all) slot.followedAllAt = now;
  return all ? 'all' : 'in_motion';
}
