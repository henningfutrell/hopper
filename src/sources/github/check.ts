// check(): signals for a source's active jobs. Closed/unlabelled/gone issue → cancel. A job
// waiting on a question → the first comment after the question comment (by numeric id) from an
// allowlisted author, without a hopper marker, non-blank, is the answer. Edits are ignored.

import type { SourceSignal } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi, GitHubComment } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { hasMarker } from './markers.ts';

export function findAnswer(comments: GitHubComment[], questionCommentId: number, authors: string[]): GitHubComment | undefined {
  return [...comments]
    .sort((a, b) => a.id - b.id)
    .find((c) => c.id > questionCommentId && authors.includes(c.author) && !hasMarker(c.body) && c.body.trim() !== '');
}

async function checkJob(api: GitHubApi, config: GitHubSourceConfig, job: Job): Promise<SourceSignal | undefined> {
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
  if (job.status !== 'waiting_answer' || !job.questionId) return undefined;
  const questionComments = job.sourceState?.source?.questionComments as Record<string, number> | undefined;
  const qcid = questionComments?.[job.questionId];
  if (qcid === undefined) return undefined;
  const answer = findAnswer(await api.listComments(repo, number), qcid, config.authors);
  if (!answer) return undefined;
  return { kind: 'answer', jobId: job.id, questionId: job.questionId, answer: answer.body.trim(), author: answer.author, url: answer.url };
}

/** Never throws for one job: transient errors are returned per job id and the rest still run. */
export async function checkJobs(api: GitHubApi, config: GitHubSourceConfig, jobs: Job[]):
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
