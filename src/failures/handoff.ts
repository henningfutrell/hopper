// Needs a person (issue #516), pure: whether a failure record's job waits on a person — automatic handling ended
// for it — and why.
import type { FailureOutcome, FailureRecord, HandoffReason } from '../domain/types.ts';

/** The outcomes that ran the job's item again: by the assessor, a person, or anything else (`superseded`, issue #517). */
export const RAN_AGAIN: readonly FailureOutcome[] = ['retried', 'redirected', 'released', 'superseded'];

/**
 * The outcomes nothing waits on any more (issue #529): a newer job of its item exists, or its item is closed at its
 * source. Out of the action lists — Needs a person, Recent failures —, still in the profile.
 */
export const SETTLED: readonly FailureOutcome[] = ['superseded', 'item_closed'];

/**
 * Why the record's job is handed off to a person, if it is: its retries used up or a job-specific failure (a
 * person), its decision's automatic action off, or its run again refused. A pending run, a run again made, or a
 * hold its problem will release: not yet.
 */
export function handoffReason(r: FailureRecord): HandoffReason | undefined {
  if (r.pending) return undefined;
  if (r.outcome === 'not_retried') return 'not_retried';
  if (r.outcome === 'surfaced') return r.decision !== 'person' ? 'auto_off' : r.cls === 'transient' ? 'retry_limit' : 'person';
  if (r.outcome === 'held' && !r.auto) return 'auto_off';
  return undefined;
}
