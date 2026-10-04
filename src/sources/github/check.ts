// check(): cancel signals for a source's active jobs. Closed/unlabelled/gone issue → cancel.
// Nothing on the issue answers a question: questions are answered in the UI.

import type { SourceSignal } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';

type CheckConfig = Pick<GitHubSourceConfig, 'label'>;

async function checkJob(api: GitHubApi, config: CheckConfig, job: Job): Promise<SourceSignal | undefined> {
  const { repo, number } = job.source!;
  if (!repo || !number) return undefined;
  let issue;
  try {
    issue = await api.getIssue(repo, number);
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return { kind: 'cancel', jobId: job.id, reason: 'issue gone' };
    throw err;
  }
  if (issue.state === 'closed') return { kind: 'cancel', jobId: job.id, reason: 'issue closed' };
  if (!issue.labels.includes(config.label)) return { kind: 'cancel', jobId: job.id, reason: 'label removed' };
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
