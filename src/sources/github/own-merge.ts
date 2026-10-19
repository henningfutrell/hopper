// The hopper's own merge of a followed pull request (follow.ts): whether a merge closed its issue (issue #721), the close
// after the hopper's merge of one that did not (issue #677, "Closing finishes the loop"), and whether a merge read later is
// the hopper's by its merge marker (issue #1588).
import type { MergeMarker } from '../../domain/types.ts';
import { killPoint } from '../../sagas/kill-points.ts';
import type { GitHubApi } from './api.ts';
import { closesByKeyword, isClosedAsCompleted, isPartOf, worksOnAnotherIssue } from './completion.ts';

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * Whether the merge of pull request `url` closed the issue (issue #721): the issue is closed as completed, or the pull
 * request's body closes it with a closing keyword and is no part.
 */
export async function closedByMerge(api: GitHubApi, repo: string, number: number, url: string): Promise<boolean> {
  if (isClosedAsCompleted(await api.getIssue(repo, number), await api.closingPullRequest(repo, number))) return true;
  const pr = (await api.referencingPullRequests(repo, number)).find((p) => p.url === url);
  return pr !== undefined && !isPartOf(pr, repo, number) && closesByKeyword(pr.body, repo, number);
}

/** What the hopper says on the issue it closes after its own merge (issue #677): neutral, the pull request's link only. */
export const closedAfterMergeComment = (url: string): string =>
  `Closed after the merge of ${url}. The pull request had no closing keyword for this issue.`;

/**
 * After the hopper's own merge of pull request `url` that did not close the issue (issue #677): a part ("Part of #N") stays
 * a part, and so does another issue's work that only mentions this one (issue #786); else the hopper closes the issue as
 * completed and comments with its link. Whether it closed the issue. `again` (issue #1959): the merge was found by its
 * marker after a stop, which may have come after the close or the comment. A pull request whose closing keyword closed the
 * issue is left as it is; the close is made again (it changes nothing on a closed issue), and the comment only when the
 * issue does not have it yet.
 */
export async function closeAfterMerge(api: GitHubApi, repo: string, number: number, url: string, again = false): Promise<boolean> {
  const pr = (await api.referencingPullRequests(repo, number)).find((p) => p.url === url);
  if (pr && (isPartOf(pr, repo, number) || worksOnAnotherIssue(pr, repo, number))) return false;
  if (again && pr && closesByKeyword(pr.body, repo, number)) return false;
  // Closed first: a sync after a failed comment finds it closed as completed, the item done.
  await api.closeAsCompleted(repo, number);
  killPoint('follow:merge:after-issue-close');
  const comment = closedAfterMergeComment(url);
  if (again && (await api.listComments(repo, number)).some((c) => c.body.trim() === comment)) return true;
  await api.postComment(repo, number, comment);
  return true;
}

/** The hopper's own merge: made in this follow (`here`), or found by its marker after a stop (`again`, issue #1588). */
export type OwnMerge = 'here' | 'again';

/**
 * Whether merged pull request `url` closes the issue (issue #721), or the hopper closes it after its own merge (issue #677).
 * A merge found by its marker runs the close after it first (issue #1959): a stop between the close and its comment left
 * the issue closed as completed, and the comment is posted still.
 */
export async function closesIssue(api: GitHubApi, repo: string, number: number, url: string, merged: OwnMerge | undefined): Promise<boolean> {
  if (merged === 'again') return await closeAfterMerge(api, repo, number, url, true) || await closedByMerge(api, repo, number, url);
  return await closedByMerge(api, repo, number, url) || (merged === 'here' && await closeAfterMerge(api, repo, number, url));
}

/**
 * Whether merged pull request `url` is the hopper's merge by `marker` (issue #1588): the marker names it, and, when both
 * are known, its head is the head the hopper merged. Another head is a merge a person made on GitHub after a refused call.
 */
export async function mergedByMarker(api: GitHubApi, repo: string, url: string, marker: MergeMarker | undefined): Promise<boolean> {
  if (marker?.pullRequest !== url) return false;
  if (!marker.head) return true;
  const head = (await api.pullRequest(repo, numberOf(url)))?.headOid;
  return head === undefined || head === marker.head;
}
