// What the UI session routes (and the sync loop, through the SourceHost) ask of the engine.
// Each command validates, writes in one transaction, emits its event, and lets the event
// listener schedule the next Decision. Jobs are created only by ingest (source-host.ts).
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { Job, UsageReading } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import type { Cleanup } from './cleanup.ts';
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
  /** Tests only: the fake usage source has no HTTP route. */
  setFakeUsage(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export function createCommands(c: EngineContext, runner: Runner, cleanup: Cleanup): Commands {
  const { store } = c;
  return {
    cancel(id, reason) {
      const job = existing(c, id);
      if (job.status === 'claimed' || job.status === 'running') {
        // The runner ends it `cancelled` once the executor has stopped.
        if (runner.cancel(id, reason)) return job;
      }
      // A waiting_answer job's question is cancelled in the same tx; a job parked or about to
      // resume holds a pane, released after the commit.
      const next = store.tx(() => {
        if (job.status === 'waiting_answer' && job.questionId) c.questions.cancel(job.questionId);
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
        const next = store.jobs.update(id, { status: 'operator_led', accepted: true, holdReason: undefined, startedAt: nowIso(c) });
        store.events.append({ type: 'job.claimed_by_operator', jobId: id, data: {} });
        return next;
      });
    },

    setFakeUsage(reading) {
      if (!c.fakeUsage) throw new EngineError('not_found', 'no fake usage source is configured');
      const readings = c.fakeUsage.set(reading);
      c.trigger('usage.changed');
      return readings;
    },
  };
}
