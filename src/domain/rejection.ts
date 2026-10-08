// A rejected job's rejection, as a job source reads it (issue #387, JobSourceContext.rejections): when, and
// the assignee it was taken for. A source does not take the item again until it is handed to that assignee
// again after this time.
import type { Job } from './types.ts';

export interface Rejection { at: string; assignee?: string }

export function rejectionOf(job: Job | undefined): Rejection | undefined {
  if (job?.status !== 'rejected') return undefined;
  return { at: job.finishedAt ?? job.updatedAt, ...(job.source?.assignee ? { assignee: job.source.assignee } : {}) };
}
