// The hopper's own merge of a followed pull request (follow.ts): whether a merge closed its issue (issue #721), the close
// after the hopper's merge of one that did not (issue #677, "Closing finishes the loop"), and whether a merge read later is
// the hopper's by its merge marker (issue #1588).
import type { MergeMarker } from '../../domain/types.ts';
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
 * completed and comments with its link. Whether it closed the issue.
 */
export async function closeAfterMerge(api: GitHubApi, repo: string, number: number, url: string): Promise<boolean> {
  const pr = (await api.referencingPullRequests(repo, number)).find((p) => p.url === url);
  if (pr && (isPartOf(pr, repo, number) || worksOnAnotherIssue(pr, repo, number))) return false;
  // Closed first: a sync after a failed comment finds it closed as completed, the item done.
  await api.closeAsCompleted(repo, number);
  await api.postComment(repo, number, closedAfterMergeComment(url));
  return true;
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
