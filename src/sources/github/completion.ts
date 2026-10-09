// The GitHub source's definition of done (issues #171, #187, #350, #579). A job that ended done is complete when
// its issue is **closed as complete** — by the merge of the job's own pull request, opened at or after the job's
// createdAt (a merge closes an issue only on the default branch, `dev`), or, no pull request closing it, closed as
// completed at or after the job's createdAt: by a commit, or with no code at all (issue #350) — or when the job's
// own pull request is open, ready for review (not a draft) and free of merge conflicts, and closes the issue when
// merged. A merge is never needed (issue #579: a pull request is done; a merge is only allowed, by yolo mode).
// Anything else — a local commit, a branch, a draft, an issue closed as not planned or before the job, an older pull
// request — is not complete; an error asking GitHub throws. A failed job whose issue is closed as complete is
// finished too (`closedAsComplete`, asked by the sync loop before it reports the failure): its work landed, and its
// pane ended after.

import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, GitHubApi, GitHubIssue } from './api.ts';

/** The job's own pull request: opened at or after the job was created. */
export const isOwnPullRequest = <P extends { createdAt: string }>(pr: P | undefined, job: Job): pr is P =>
  pr !== undefined && Date.parse(pr.createdAt) >= Date.parse(job.createdAt);

/**
 * Closed as complete: by the job's own merged pull request (`closer`, the last close event's), or, no
 * pull request closing it, as completed at or after the job was created — a commit, or by hand (issue #350).
 */
export function isClosedAsComplete(issue: GitHubIssue, closer: ClosingPullRequest | undefined, job: Job): boolean {
  if (issue.state !== 'closed') return false;
  if (closer) return isOwnPullRequest(closer, job);
  return issue.stateReason === 'completed' && issue.closedAt !== undefined && Date.parse(issue.closedAt) >= Date.parse(job.createdAt);
}

export async function notComplete(api: GitHubApi, job: Job): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  const closer = await api.closingPullRequest(repo, number);
  if (isOwnPullRequest(closer, job)) return undefined;
  const found = await api.getIssue(repo, number);
  if (isClosedAsComplete(found, closer, job)) return undefined;
  const open = await api.openClosingPullRequests(repo, number);
  if (open.some((pr) => !pr.isDraft && !pr.conflicting && isOwnPullRequest(pr, job))) return undefined;
  return `no pull request opened by this job, ready for review, closes ${url ?? `${repo}#${number}`}`;
}

/**
 * Whether the job's issue is closed, by any means, or gone (issue #529): a hand-off of its job waits on nobody. No
 * access (403) cannot tell: false. A transient error throws, to be asked again.
 */
export async function issueClosed(api: GitHubApi, job: Job): Promise<boolean> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return false;
  try {
    return (await api.getIssue(repo, number)).state === 'closed';
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return err.status === 404 || err.status === 410;
    throw err;
  }
}

/**
 * Whether the job's issue is closed as complete. A permanent error (the issue gone, no access) is not:
 * the failure is reported, and meets the same error there; a transient one throws, to be asked again.
 */
export async function closedAsComplete(api: GitHubApi, job: Job): Promise<boolean> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return false;
  try {
    const issue = await api.getIssue(repo, number);
    return issue.state === 'closed' && isClosedAsComplete(issue, await api.closingPullRequest(repo, number), job);
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return false;
    throw err;
  }
}
