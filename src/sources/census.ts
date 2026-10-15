// The census of open pull requests (issue #1176, design.md "Untracked pull requests"), the sync loop's half: in a round of
// every follow, after reconciling and the strays, the source is asked to list the open pull requests of its job
// repositories it does not track (`JobSource.censusPullRequests`). Tracked: one a job of the source names, or one the
// ledger holds as an item's pull request. In Intake: an issue a job of the source has, or one the ledger holds as an item
// (a request card too). Followed: the pull request a job of the item follows (`following`), which a second one names. At most once an hour for each source (`CENSUS_EVERY_MS`): it reads every job repository, and an
// untracked pull request changes slowly, so it does not spend GitHub's budget at each round; a sync a person asked for (or a
// start) runs it at once, so the list shows what they changed. Not while the source is
// paused; a throw is logged and asked again at the next round.
import type { JobSource } from '../domain/ports.ts';
import { following } from '../domain/pull-requests.ts';
import type { Job } from '../domain/types.ts';
import type { AfterDoneContext } from './after-done.ts';

/** How often a source's census runs, at most. */
export const CENSUS_EVERY_MS = 60 * 60_000;

export function pullRequestCensus(c: Pick<AfterDoneContext, 'store' | 'now'>) {
  const { store } = c;
  /** When each source's last census worked, by its name. */
  const lastAt = new Map<string, number>();
  /** The census of the source's open pull requests, against `listed`, the source's jobs. */
  return async function census(source: JobSource, listed: Job[], asked: boolean): Promise<void> {
    if (!source.censusPullRequests || source.paused?.() !== undefined) return;
    const now = c.now();
    const last = lastAt.get(source.name);
    if (!asked && last !== undefined && now - last < CENSUS_EVERY_MS) return;
    const jobs = listed.map((j) => store.jobs.get(j.id) ?? j);
    const named = new Set(jobs.flatMap((j) => {
      const pr = (j.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
      return typeof pr === 'string' ? [pr.toLowerCase()] : [];
    }));
    const keys = new Set(jobs.flatMap((j) => (j.source?.key ? [j.source.key.toLowerCase()] : [])));
    /** The pull request a job of each item follows, by the item's key. */
    const followed = new Map(jobs.flatMap((j) => {
      const pr = (j.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
      return j.source?.key && typeof pr === 'string' && following(j) ? [[j.source.key.toLowerCase(), pr] as const] : [];
    }));
    try {
      await source.censusPullRequests({
        tracked: (url) => named.has(url.toLowerCase()) || store.workItems.byPullRequest(url) !== undefined,
        issueTracked: (url) => keys.has(url.toLowerCase()) || store.workItems.get(url) !== undefined,
        followedOf: (url) => followed.get(url.toLowerCase()),
      });
      lastAt.set(source.name, now);
    } catch (e) {
      console.warn(`hopper: ${source.name}: the census of open pull requests failed, asked again at the next round: ${(e as Error).message}`);
    }
  };
}
