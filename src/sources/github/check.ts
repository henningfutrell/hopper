// check(): cancel signals for a source's active jobs. Closed/unlabelled/gone issue → cancel; a
// waiting job whose issue went on the backburner → cancel (a running job is left to finish).
// Only GitHub saying so about the issue itself (404, 410) is "gone": an error about the source —
// no app configured, refused credentials, app not installed, 403, a missing scope — cancels
// nothing, however permanent; the job is skipped and the error shown (issue #52: the boot after an
// install could not read its app key, and every active job was cancelled).
// An issue closed by the merge of a pull request opened after the job was created is the job's own
// work landing, not a cancel: the job runs on to its own end (a job merges before it installs and
// verifies). A pull request opened earlier is somebody else's, and cancels as any close does. So is
// an issue closed with no pull request as completed after the job was created — by a commit, or with
// no code (issue #350) — once the job has started; a job still waiting to run is cancelled.
// Nothing on the issue answers a question: questions are answered in the UI.

import type { SourceSignal } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { LABEL_BACKBURNER } from './labels.ts';
import { isClosedAsComplete, isOwnPullRequest } from './completion.ts';

type CheckConfig = Pick<GitHubSourceConfig, 'label'>;

/** A permanent error asking GitHub counts as "not its own": the close cancels, as before. */
async function closedByOwnWork(api: GitHubApi, job: Job, issue: GitHubIssue, started: boolean): Promise<boolean> {
  let pr;
  try {
    pr = await api.closingPullRequest(issue.repo, issue.number);
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return false;
    throw err;
  }
  return isOwnPullRequest(pr, job) || (started && isClosedAsComplete(issue, pr, job));
}

async function checkJob(api: GitHubApi, config: CheckConfig, job: Job): Promise<SourceSignal | undefined> {
  const { repo, number } = job.source!;
  if (!repo || !number) return undefined;
  let issue;
  try {
    issue = await api.getIssue(repo, number);
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) return { kind: 'cancel', jobId: job.id, reason: 'issue gone' };
    throw err;
  }
  const waiting = job.status === 'queued' || job.status === 'held';
  if (issue.state === 'closed') return await closedByOwnWork(api, job, issue, !waiting) ? undefined : { kind: 'cancel', jobId: job.id, reason: 'issue closed' };
  if (!issue.labels.includes(config.label)) return { kind: 'cancel', jobId: job.id, reason: 'label removed' };
  if (waiting && issue.labels.includes(LABEL_BACKBURNER)) return { kind: 'cancel', jobId: job.id, reason: 'backburner' };
  return undefined;
}

/** Never throws for one job: transient errors are returned per job id and the rest still run. */
export async function checkJobs(api: GitHubApi, config: CheckConfig, jobs: Job[]):
Promise<{ signals: SourceSignal[]; errors: Record<string, string> }> {
  const signals: SourceSignal[] = [];
  const errors: Record<string, string> = {};
  for (const job of jobs) {
    try {
      const s = await checkJob(api, config, job);
      if (s) signals.push(s);
    } catch (err) {
      errors[job.id] = (err as Error).message;
    }
  }
  return { signals, errors };
}
