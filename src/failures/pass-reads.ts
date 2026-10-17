// A pass over many failed jobs, failure records or hand-offs (issue #1411): what nothing waits on any more, checked with
// a fixed number of reads of the jobs table for the whole pass — the jobs and the newest job of each of their items, read
// once at its start —, not one or more for each job. With about 150 jobs in the store, a pass that read one job at a time,
// run after each job that ended, stalled the event loop for seconds. A pass reads a job again, in its transaction, only
// when it acts on it.
import type { UserStore } from '../domain/ports.ts';
import type { Handoff, HandoffEnd, Job } from '../domain/types.ts';
import { itemEnded } from './stale.ts';
import { newerOf } from './view.ts';

/** What a pass read at its start. */
export interface PassReads { jobs: ReadonlyMap<string, Job>; newest: ReadonlyMap<string, Job> }

/** The newest job of each item of `jobs`, in one read. */
export function newestOfJobs(store: Pick<UserStore, 'jobs'>, jobs: Iterable<Job>): Map<string, Job> {
  return store.jobs.newestOfItems([...jobs].flatMap((j) => (j.source ? [j.source.key] : [])));
}

/** The jobs of `jobIds` and the newest job of each of their items. */
export function passReads(store: Pick<UserStore, 'jobs'>, jobIds: readonly string[]): PassReads {
  const jobs = store.jobs.getMany(jobIds);
  return { jobs, newest: newestOfJobs(store, jobs.values()) };
}

/**
 * Why an open hand-off waits on nobody now, if it does not: its job gone or finished, or a newer job of its item.
 * `read`: as read for a pass; else reads of its own.
 */
export function staleOf(store: Pick<UserStore, 'jobs'>, h: Handoff, read?: PassReads): { end: HandoffEnd; nextJobId?: string } | undefined {
  const job = read ? read.jobs.get(h.jobId) : store.jobs.get(h.jobId);
  if (!job) return { end: 'job_gone' };
  if (job.status === 'finished') return { end: 'finished' };
  const newer = newerOf(store, job, read?.newest);
  return newer ? { end: 'superseded', nextJobId: newer } : undefined;
}

/** Why a failed job's locked entry waits on nobody any more (issue #1123), if it does not. `newest`: as `newerOf`. */
export function staleEnd(store: Pick<UserStore, 'jobs' | 'workItems'>, job: Job, newest?: ReadonlyMap<string, Job>): { end: 'superseded' | 'item_closed'; nextJobId?: string } | undefined {
  if (job.status !== 'failed' || job.dismissedAt !== undefined || !job.source) return undefined;
  const newer = newerOf(store, job, newest);
  if (newer) return { end: 'superseded', nextJobId: newer };
  const item = store.workItems.get(job.source.key);
  return item && itemEnded(item) ? { end: 'item_closed' } : undefined;
}
