// A source not configured (issue #1243, `JobSource.setupProblem`): the sync loop runs no sync pass for it while no job of
// its own needs one — such a pass asks nothing and looks like a healthy zero. Its status is `needs-setup` with the problem,
// never ok; the log says it once when it starts or changes, and once when it clears.
import { TERMINAL_STATUSES, type Job, type SetupProblem } from '../domain/types.ts';
import { detailOf, type Slot } from './sync-slots.ts';
import type { SyncFlags } from './sync-signals.ts';

/** A job of the source that a sync still checks or reports: active, or its claim or end not reported yet. */
export function needsWork(j: Job): boolean {
  const f = (j.sourceState?.sync ?? {}) as SyncFlags;
  return !TERMINAL_STATUSES.includes(j.status) || !f.finalReported || !f.claimReported;
}

/** Say a source's setup problem in the log once when it starts or changes, and once when it clears. */
export function setupTold(slot: Slot, setup: SetupProblem | undefined): void {
  if (setup?.reason === slot.setupSaid) return;
  if (setup) {
    console.warn(`hopper: source ${slot.source.name} not configured: ${setup.reason}`);
    slot.setupSaid = setup.reason;
  } else {
    console.warn(`hopper: source ${slot.source.name} configured`);
    delete slot.setupSaid;
  }
}

/**
 * Say why a source is paused (issue #1351) once when it starts or changes, and once when it ends: a paused pass asks GitHub
 * nothing new, and its traffic line alone reads as a healthy zero. A setup problem says itself (setupTold).
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

/** The status of a sync that ran no pass for want of setup: nothing seen, never ok, the problem named. */
export function notConfigured(slot: Slot, setup: SetupProblem, now: Date, paused: string | undefined): void {
  const st = slot.status;
  delete st.syncing;
  slot.notRerun = [];
  Object.assign(st, { state: 'needs-setup', setupProblem: setup, itemsSeen: 0, activeJobs: 0, lastSyncAt: now.toISOString() });
  st.detail = detailOf(slot, paused, 0);
}
