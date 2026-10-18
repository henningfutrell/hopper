// A GitLab job's merge request and its signals (issue #1642, design.md "A GitLab job's merge request"). Done is judged by
// what GitLab shows, as the GitHub source judges a pull request (`notComplete`): a merge request whose description closes the
// issue — GitLab's `closed_by` — open, not a draft, free of merge conflicts and its pipeline not failed, or merged since the
// job began; or the issue closed by a merged one. The signals (`check`) for the source's jobs not ended: the issue closed by
// anything but the job's own merge request (one opened since the job began), its label removed, or the issue gone, cancels
// the job; a job on its own wait whose own merge request closed the issue ends finished; a waiting job on the backburner is
// cancelled. Assignment drift as on GitHub: unassigned while it waits, cancelled; once started, flagged. Only GitLab saying
// the issue is not there (404, 410) is "gone": any other error skips the job, and is said in the source's detail. A job that
// got done criteria (issue #1924 part 4, done-criteria.ts) is done by its newest ready merge request only when they are met.
import type { SourceSignal } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { LABEL_BACKBURNER } from '../sources/github/labels.ts';
import { GitLabNotFound, GitLabTokenRefused, type GitLabApi, type GitLabMergeRequest } from './api.ts';
import { mergeRequestMiss, type GitLabDoneCriteria } from './done-criteria.ts';

/** The head pipeline statuses that keep a merge request from done: its checks failed. */
const FAILED_PIPELINE = 'failed';

const since = (at: string | undefined, job: Job): boolean => at !== undefined && Date.parse(at) >= Date.parse(job.createdAt);
const isReady = (m: GitLabMergeRequest): boolean => m.state === 'opened' && !m.draft && !m.conflicting && m.pipeline !== FAILED_PIPELINE;
/** Merged by the job's own merge request: one opened since the job began. */
const ownMerged = (list: readonly GitLabMergeRequest[], job: Job): boolean => list.some((m) => m.state === 'merged' && since(m.createdAt, job));

/** How a merge request was found, for the miss's text: `!N (opened, draft)`. */
function described(m: GitLabMergeRequest): string {
  const why = m.state !== 'opened' ? [] : [...(m.draft ? ['draft'] : []), ...(m.conflicting ? ['merge conflicts'] : []), ...(m.pipeline === FAILED_PIPELINE ? ['pipeline failed'] : [])];
  return `!${m.iid} (${[m.state, ...why].join(', ')})`;
}

/**
 * Undefined: the GitLab job is done. Else why not, naming the merge requests looked at; or its done criteria not met on its
 * newest ready merge request (`MR !N`). An error asking GitLab throws.
 */
export async function notComplete(api: GitLabApi, job: Job, done?: GitLabDoneCriteria): Promise<string | undefined> {
  const { repo: project, number: iid } = job.source ?? {};
  if (!project || !iid) return `job ${job.id} names no GitLab issue`;
  const [issue, list] = await Promise.all([api.issue(project, iid), api.closingMergeRequests(project, iid)]);
  if (issue.state === 'closed' && list.some((m) => m.state === 'merged')) return undefined;
  const ready = list.filter(isReady).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (ready) return mergeRequestMiss(api, job, issue.url, ready, done);
  if (list.some((m) => m.state === 'merged' && since(m.mergedAt, job))) return undefined;
  const state = issue.state === 'opened' ? 'is open' : 'is closed, not by a merge request';
  const found = list.length === 0 ? `no merge request in ${project} closes it`
    : `no merge request that closes it is ready for review or merged since the job began: ${list.map(described).join(', ')}`;
  return `the issue ${issue.url} ${state}, and ${found}`;
}

async function checkJob(api: GitLabApi, label: string, job: Job): Promise<SourceSignal | undefined> {
  const { repo: project, number: iid, assignee } = job.source ?? {};
  if (!project || !iid) return undefined;
  let issue;
  try { issue = await api.issue(project, iid); } catch (err) {
    if (err instanceof GitLabNotFound) return { kind: 'cancel', jobId: job.id, reason: 'issue gone' };
    throw err;
  }
  const waiting = job.status === 'queued' || job.status === 'held';
  if (issue.state === 'closed') {
    if (!ownMerged(await api.closingMergeRequests(project, iid), job)) return { kind: 'cancel', jobId: job.id, reason: 'issue closed' };
    return job.status === 'waiting_on' ? { kind: 'finish', jobId: job.id, reason: 'issue closed as complete' } : undefined;
  }
  if (!issue.labels.includes(label)) return { kind: 'cancel', jobId: job.id, reason: 'label removed' };
  if (waiting && issue.labels.includes(LABEL_BACKBURNER)) return { kind: 'cancel', jobId: job.id, reason: 'backburner' };
  if (assignee === undefined) return undefined;
  const flagged = typeof job.sourceState?.sync?.unassignedAt === 'string';
  if (issue.assignees.some((a) => a.toLowerCase() === assignee.toLowerCase())) return flagged ? { kind: 'reassigned', jobId: job.id } : undefined;
  if (waiting) return { kind: 'cancel', jobId: job.id, reason: 'unassigned' };
  return flagged ? undefined : { kind: 'unassigned', jobId: job.id };
}

/**
 * The signals for `source`'s jobs not ended. Never throws for one job: its error is answered by its id, and the rest still
 * run. GitLab refusing the token throws.
 */
export async function checkJobs(api: GitLabApi, source: string, label: string, active: readonly Job[]): Promise<{ signals: SourceSignal[]; errors: Record<string, string> }> {
  const signals: SourceSignal[] = [];
  const errors: Record<string, string> = {};
  for (const job of active.filter((j) => j.source?.source === source && !TERMINAL_STATUSES.includes(j.status))) {
    try {
      const s = await checkJob(api, label, job);
      if (s) signals.push(s);
    } catch (err) {
      if (err instanceof GitLabTokenRefused) throw err; // the account ends: the rest would be refused too
      errors[job.id] = (err as Error).message;
    }
  }
  return { signals, errors };
}
