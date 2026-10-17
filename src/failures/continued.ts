// A failed job that is live again (issue #1777): a Continue, Push it or a resume took it back to the queue, so its
// failure record waits on nothing any more — not its problem's hold, not a pending run again. The record ends taken, with
// the job itself as its next job (`retried`: a new failure of it is assessed anew), and no hand-off opens for it.
import type { UserStore } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type FailureOutcome, type FailureRecord, type Job, type JobStatus } from '../domain/types.ts';

/** The outcomes that still wait: nothing ran its job again yet. */
const WAITING: readonly FailureOutcome[] = ['surfaced', 'not_retried', 'held'];

export const LIVE_AGAIN_NOTE = 'its job went on again';

/** Whether the job is live: not ended. */
export const live = (job: Pick<Job, 'status'> | undefined): boolean => job !== undefined && !TERMINAL_STATUSES.includes(job.status);

/** Why a live job's item is not taken back, nor its hand-off resolved: it is not ended. */
export const liveWhy = (status: JobStatus): string =>
  status === 'queued' ? 'it is already queued again: it runs when a lane is free' : `it is already ${status.replace(/_/g, ' ')} again: it is not ended`;

/** Whether the record still waits: a run again pending, or held, surfaced or refused. */
export const waits = (r: FailureRecord): boolean => r.pending !== undefined || r.outcome === undefined || WAITING.includes(r.outcome);

/**
 * In a transaction: the job's record, while it waits and the job is live, ends taken by that job. The record, or undefined
 * when there was nothing to end.
 */
export function settleLiveAgain(store: Pick<UserStore, 'failures' | 'jobs'>, jobId: string, at: string): FailureRecord | undefined {
  const r = store.failures.forJob(jobId);
  if (!r || !waits(r) || !live(store.jobs.get(jobId))) return undefined;
  return store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: 'retried', outcomeAt: at, nextJobId: jobId, note: LIVE_AGAIN_NOTE });
}
