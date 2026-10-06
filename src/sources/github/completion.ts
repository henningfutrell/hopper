// The GitHub source's definition of done (issues #171, #187). A job that ended done is complete
// only when its own pull request — opened at or after the job's createdAt — reached the issue's
// completion: `merge`, the pull request merged and closed the issue (a merge closes an issue only
// on the default branch, so that is the change on main); `pull-request`, the pull request is open,
// not a draft, and closes the issue when merged (a merged one went further, and counts too). The
// completion is the source's `completion` option unless a completion label on the issue sets it;
// both labels: merge, the stricter. Anything else — a local commit, a branch, the issue closed by a
// person, a commit or an older pull request — is not complete; an error asking GitHub throws.

import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { LABEL_COMPLETE_AT_MERGE, LABEL_COMPLETE_AT_PR } from './labels.ts';

export type Completion = GitHubSourceConfig['completion'];

/** The job's own pull request: opened at or after the job was created. */
export const isOwnPullRequest = <P extends { createdAt: string }>(pr: P | undefined, job: Job): pr is P =>
  pr !== undefined && Date.parse(pr.createdAt) >= Date.parse(job.createdAt);

/** The issue's completion: a completion label, else the configured one. */
export function completionOf(labels: string[], configured: Completion): Completion {
  if (labels.includes(LABEL_COMPLETE_AT_MERGE)) return 'merge';
  if (labels.includes(LABEL_COMPLETE_AT_PR)) return 'pull-request';
  return configured;
}

export async function notComplete(api: GitHubApi, job: Job, configured: Completion): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  if (isOwnPullRequest(await api.closingPullRequest(repo, number), job)) return undefined;
  const issue = url ?? `${repo}#${number}`;
  const completion = completionOf((await api.getIssue(repo, number)).labels, configured);
  if (completion === 'merge') return `no merged pull request opened by this job closes ${issue}`;
  const open = await api.openClosingPullRequests(repo, number);
  if (open.some((pr) => !pr.isDraft && isOwnPullRequest(pr, job))) return undefined;
  return `no pull request opened by this job, ready for review, closes ${issue}`;
}
