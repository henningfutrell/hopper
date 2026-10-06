// The queue gate (issue #159, design.md "Queue gate"): what a new job passes before it may run.
// Re-exported from types.ts.
import type { JobId } from './types.ts';

/** `auto-accept`: the pre-sort's verdict is applied as it comes. `review`: the user accepts or rejects each job. */
export type QueueGateMode = 'auto-accept' | 'review';
export const QUEUE_GATE_MODES: readonly QueueGateMode[] = ['auto-accept', 'review'];

/** A user's queue gate. `autoAcceptPerHour`: the throttle — at most this many jobs auto-accepted in any hour; null: no limit. */
export interface QueueGate {
  mode: QueueGateMode;
  autoAcceptPerHour: number | null;
}

export const DEFAULT_QUEUE_GATE: QueueGate = { mode: 'auto-accept', autoAcceptPerHour: null };

/** Who let a job through the gate, or turned it away: the user, or the pre-sort. */
export type GateActor = 'user' | 'pre-sort';

/** A job the pre-sort would reject, and why. */
export interface PreSortReject {
  jobId: JobId;
  reason: string;
}

/** The queue sorter's verdict on the jobs not yet accepted: their order, and the ones it rejects. */
export interface PreSort {
  /** The queue-sorter instance name. */
  sorter: string;
  jobIds: JobId[];
  reject: PreSortReject[];
}
