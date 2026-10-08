// What the UI session routes (and the sync loop, through the SourceHost) ask of the engine.
// Each command validates, writes in one transaction, emits its event, and lets the event
// listener schedule the next Decision. Jobs are created only by ingest (source-host.ts).
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { Job, UsageReading } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import type { Cleanups } from './cleanup.ts';
import { parkRefusal, recordPark, recordUnpark, releaseParked } from './park.ts';
import type { Runner } from './runner.ts';

const isTerminal = (job: Job): boolean => TERMINAL_STATUSES.includes(job.status);

function existing(c: EngineContext, id: string): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (isTerminal(job)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  return job;
}

export interface Commands {
  /** Cancel a non-terminal job; `reason` is recorded on job.cancelled (and told to its source). */
  cancel(id: string, reason: string): Job;
  approve(id: string): Job;
  /**
   * Claim a waiting job as operator-led (issue #318): an operator does its work by hand, outside the
   * hopper. It holds no lane and the decider never runs it; its source finishes it once its work is complete.
   */
  claimByOperator(id: string): Job;
  /** Take a locked entry out of the queue (issue #355): the failed job stays failed, and can still run again. */
  dismiss(id: string): Job;
  /**
   * Park a running job, or one on a question (issue #501): its lane frees, its pane and agent end, its work tree,
   * agent session, machine and open question are kept. A running job is parked once its executor stepped aside.
   */
  park(id: string): Job;
  /** Re-queue a parked job (issue #501): pinned to its machine, its claim resumes its agent session; with its question open, it waits on it again. */
  requeue(id: string): Job;
  /** Issue #371: what a job's deferred cleanup could not reach was closed by hand; it is no longer tried, and its item's jobs may run. */
  markCleanedUp(id: string): Job;
  /** Tests only: the fake usage source has no HTTP route. */
  setFakeUsage(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export function createCommands(c: EngineContext, runner: Runner, cleanups: Cleanups): Commands {
  const { store } = c;
  const cleanup = cleanups.run;
  return {
    cancel(id, reason) {
      const job = existing(c, id);
      if (job.status === 'claimed' || job.status === 'running') {
        // The runner ends it `cancelled` once the executor has stopped.
        if (runner.cancel(id, reason)) return job;
      }
      // A waiting_answer or parked job's question is cancelled in the same tx; a job on a question or about to
      // resume holds a pane, and a parked job its work tree, released after the commit by the normal reap.
      const next = store.tx(() => {
        if ((job.status === 'waiting_answer' || job.status === 'parked') && job.questionId) c.questions.cancel(job.questionId);
        const cancelled = store.jobs.update(id, { status: 'cancelled', finishedAt: nowIso(c), pendingAnswer: undefined });
        store.events.append({ type: 'job.cancelled', jobId: id, data: { reason } });
        return cancelled;
      });
      void cleanup(id);
      return next;
    },

    approve(id) {
      existing(c, id);
      return store.tx(() => {
        const next = store.jobs.update(id, { approved: true });
        store.events.append({ type: 'job.approved', jobId: id, data: {} });
        return next;
      });
    },

    claimByOperator(id) {
      return store.tx(() => {
        const job = existing(c, id);
        if (job.status !== 'queued' && job.status !== 'held') throw new EngineError('conflict', `job ${id} is ${job.status}: only a waiting job can be claimed as operator-led`);
        const next = store.jobs.update(id, { status: 'operator_led', accepted: true, holdReason: undefined, waitReason: undefined, startedAt: nowIso(c) });
        store.events.append({ type: 'job.claimed_by_operator', jobId: id, data: {} });
        return next;
      });
    },

    dismiss(id) {
      return store.tx(() => {
        const job = store.jobs.get(id);
        if (!job) throw new EngineError('not_found', `job ${id} not found`);
        if (job.status !== 'failed' || job.dismissedAt !== undefined) throw new EngineError('conflict', `job ${id} is not a locked entry: only a failed job not yet dismissed can be dismissed`);
        const next = store.jobs.update(id, { dismissedAt: nowIso(c) });
        store.events.append({ type: 'job.dismissed', jobId: id, data: { by: 'user' } });
        return next;
      });
    },

    park(id) {
      const job = existing(c, id);
      const refused = parkRefusal(c, job);
      if (refused) throw new EngineError('conflict', refused);
      if (job.status === 'running') {
        if (runner.park(id)) return job;
        throw new EngineError('conflict', `job ${id} is not running here yet: try again`);
      }
      const parked = store.tx(() => {
        // Read again in the tx: an answer may have re-queued it meanwhile.
        const now = existing(c, id);
        const late = parkRefusal(c, now);
        if (late) throw new EngineError('conflict', late);
        return recordPark(c, now, 'waiting_answer');
      });
      void releaseParked(c, parked);
      return parked;
    },

    requeue(id) {
      const next = store.tx(() => recordUnpark(c, id));
      if (next.status === 'waiting_answer' && next.questionId) c.questions.unparked(next.questionId);
      return next;
    },

    markCleanedUp: (id) => cleanups.markCleanedUp(id),

    setFakeUsage(reading) {
      if (!c.fakeUsage) throw new EngineError('not_found', 'no fake usage source is configured');
      const readings = c.fakeUsage.set(reading);
      c.trigger('usage.changed');
      return readings;
    },
  };
}
