// The queue's state (issue #1486, design.md "Telemetry"): the live jobs by status and the lanes by state, across every
// user, read at each collection. Started after the SDK: its gauges are the meter provider's of that moment.
import { metrics, type BatchObservableResult } from '@opentelemetry/api';
import type { Job, JobStatus, Lane } from '../domain/types.ts';
import { SCOPE } from './instruments.ts';

/** Jobs not ended: the queue's state reports them by status. */
const OPEN_JOB_STATUSES: JobStatus[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'waiting_on', 'operator_led', 'parked'];

/** What the queue's state is read from: each user's jobs and lanes. */
export interface QueueStore {
  jobs: { list(filter: { status: JobStatus[] }): Job[] };
  lanes: { list(): Lane[] };
}

export interface QueueCounts {
  /** Live jobs by status. */
  jobs: Record<string, number>;
  /** Lanes by state (idle, busy, draining). */
  lanes: Record<string, number>;
}

/** Reports `read()` at each collection; the returned function stops it. */
export function observeQueue(read: () => QueueCounts): () => void {
  const meter = metrics.getMeterProvider().getMeter(SCOPE);
  const jobs = meter.createObservableGauge('hopper.jobs', { description: 'Live jobs, by status.' });
  const lanes = meter.createObservableGauge('hopper.lanes', { description: 'Lanes, by state.' });
  const callback = (r: BatchObservableResult): void => {
    let counts: QueueCounts;
    try { counts = read(); } catch { return; } // a store that cannot answer now reports nothing this time
    for (const [status, n] of Object.entries(counts.jobs)) r.observe(jobs, n, { 'hopper.job.status': status });
    for (const [state, n] of Object.entries(counts.lanes)) r.observe(lanes, n, { 'hopper.lane.state': state });
  };
  meter.addBatchObservableCallback(callback, [jobs, lanes]);
  return () => { meter.removeBatchObservableCallback(callback, [jobs, lanes]); };
}

/** Counts of each value: `['busy', 'idle', 'busy']` → `{ busy: 2, idle: 1 }`. */
export function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

/** The queue's state of every user's store, at each collection. */
export function observeQueueOf(stores: () => QueueStore[]): () => void {
  return observeQueue(() => {
    const all = stores();
    return {
      jobs: countBy(all.flatMap((s) => s.jobs.list({ status: OPEN_JOB_STATUSES })), (j) => j.status),
      lanes: countBy(all.flatMap((s) => s.lanes.list()), (l) => l.state),
    };
  });
}
