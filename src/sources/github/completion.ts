// notShipped(): a job that ended done shipped only when a pull request it opened (at or after the
// job's createdAt) was merged and closed its issue (issue #171). A merge closes the issue only on
// the default branch, so that is the change on main. Anything else — the issue open, closed by a
// person, a commit or an older pull request — is nothing shipped; an error asking GitHub throws.

import type { Job } from '../../domain/types.ts';
import type { ClosingPullRequest, GitHubApi } from './api.ts';

/** The job's own pull request: opened at or after the job was created. */
export const isOwnPullRequest = (pr: ClosingPullRequest | undefined, job: Job): pr is ClosingPullRequest =>
  pr !== undefined && Date.parse(pr.createdAt) >= Date.parse(job.createdAt);

export async function notShipped(api: GitHubApi, job: Job): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  const pr = await api.closingPullRequest(repo, number);
  if (isOwnPullRequest(pr, job)) return undefined;
  return `no merged pull request opened by this job closes ${url ?? `${repo}#${number}`}`;
}
