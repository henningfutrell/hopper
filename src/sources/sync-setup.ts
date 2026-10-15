// What a sync tells of a source beside its pass: which of its jobs still need work, and why it is paused, in the log.
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import type { Slot } from './sync-slots.ts';
import type { SyncFlags } from './sync-signals.ts';

/** A job of the source that a sync still checks or reports: active, or its claim or end not reported yet. */
export function needsWork(j: Job): boolean {
  const f = (j.sourceState?.sync ?? {}) as SyncFlags;
  return !TERMINAL_STATUSES.includes(j.status) || !f.finalReported || !f.claimReported;
}

/**
 * Say why a source is paused (issue #1351) once when it starts or changes, and once when it ends: a paused pass asks GitHub
 * nothing new, and its traffic line alone reads as a healthy zero.
 */
export function pauseTold(slot: Slot, paused: string | undefined): void {
  if (paused === slot.pauseSaid) return;
  if (paused !== undefined) {
    console.warn(`hopper: source ${slot.source.name} paused, nothing new is taken: ${paused}`);
    slot.pauseSaid = paused;
  } else {
    console.warn(`hopper: source ${slot.source.name} no longer paused`);
    delete slot.pauseSaid;
  }
}
