// The GitHub source's definition of done (issues #171, #187, #350). A job that ended done is complete
// when its issue reached its completion: `merge`, the issue is **closed as complete** — by the merge
// of the job's own pull request, opened at or after the job's createdAt (a merge closes an issue only
// on the default branch, `dev`), or, no pull request closing it, closed as
// completed at or after the job's createdAt: by a commit, or with no code at all (issue #350: a job
// may end its issue without a pull request); `pull-request`, that, or the job's own pull request is
// open, not a draft, and closes the issue when merged. The completion is the source's `completion`
// option unless a completion label on the issue sets it; both labels: merge, the stricter. Anything
// else — a local commit, a branch, an issue closed as not planned or before the job, an older pull
// request — is not complete; an error asking GitHub throws. A failed job whose issue is closed as
// complete is finished too (`closedAsComplete`, asked by the sync loop before it reports the
// failure): its work landed, and its pane ended after.

import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { LABEL_COMPLETE_AT_MERGE, LABEL_COMPLETE_AT_PR } from './labels.ts';

export type Completion = GitHubSourceConfig['completion'];

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

/** The issue's completion: a completion label, else the configured one. */
export function completionOf(labels: string[], configured: Completion): Completion {
  if (labels.includes(LABEL_COMPLETE_AT_MERGE)) return 'merge';
  if (labels.includes(LABEL_COMPLETE_AT_PR)) return 'pull-request';
  return configured;
}

export async function notComplete(api: GitHubApi, job: Job, configured: Completion): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  const closer = await api.closingPullRequest(repo, number);
  if (isOwnPullRequest(closer, job)) return undefined;
  const found = await api.getIssue(repo, number);
  if (isClosedAsComplete(found, closer, job)) return undefined;
  const issue = url ?? `${repo}#${number}`;
  if (completionOf(found.labels, configured) === 'merge') return `no merged pull request opened by this job closes ${issue}`;
  const open = await api.openClosingPullRequests(repo, number);
  if (open.some((pr) => !pr.isDraft && isOwnPullRequest(pr, job))) return undefined;
  return `no pull request opened by this job, ready for review, closes ${issue}`;
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
