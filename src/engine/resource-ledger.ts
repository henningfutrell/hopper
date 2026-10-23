// The resource ledger's writes (issue #2504, design.md "The resource ledger"): entries recorded from what a job's executor
// saved, and closed as each reap — the cleanup at the job's end, the sweep, a discard — says.
import { goneClosures, ledgerEntriesOf, ledgerKey, ledgerRootsOf, reapClosures, retainedEntriesOf, unledgeredEntriesOf } from '../domain/resource-ledger.ts';
import type { Reaped, Survey } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';

type Ledger = Pick<UserStore, 'resourceLedger'>;

/** The entries the executor's saved state names, recorded on machine `machineId`; one already there is kept as it is. */
export function recordLedger(store: Ledger, jobId: string, machineId: string, state: unknown, at: string): void {
  for (const e of ledgerEntriesOf(jobId, machineId, state, at)) store.resourceLedger.record(e);
}

/** The job's entries closed as the reap said; `scratch` false: it did not look at the scratch dir, so only its scope. */
export function closeLedger(store: Ledger, jobId: string, said: Reaped, at: string, scratch = true): void {
  for (const c of reapClosures(store.resourceLedger.forJob(jobId), said, scratch)) store.resourceLedger.close(jobId, c.entry.kind, c.entry.locator, c.state, at, c.reason);
}

/** The job's entries a reap kept for a retention (issue #2504 part 5), marked kept until `until`: no cleanup leftover before then. */
export function retainLedger(store: Ledger, jobId: string, until: string): void {
  for (const e of retainedEntriesOf(store.resourceLedger.forJob(jobId))) store.resourceLedger.retain(jobId, e.kind, e.locator, until);
}

/**
 * The reconciler's step (issue #2504 parts 3, 8): each entry not yet reaped on machine `machineId` — kept work's too — of an
 * ended job that the survey no longer found is closed `reaped`, so a thing removed by hand is no cleanup leftover. How many it closed.
 */
export function closeGone(store: Ledger & Pick<UserStore, 'jobs'>, machineId: string, found: Survey, at: string): number {
  const closed = goneClosures(store.resourceLedger.onMachine(machineId), found, machineId, (id) => store.jobs.get(id));
  for (const c of closed) store.resourceLedger.close(c.entry.jobId, c.entry.kind, c.entry.locator, c.state, at, c.reason);
  return closed.length;
}

/**
 * The reconciler on machine `m` (issue #2504 parts 3, 6), after its survey and before the sweep's reaps: the entries whose
 * thing is gone closed (`closeGone`), then what the survey found of an ended job that no entry names recorded, so the
 * reaps close it and the leftover check tells it should it stay. `jobOf` reads the store, also for a job outside the job list.
 */
export function reconcileLedger(store: Ledger & Pick<UserStore, 'jobs'>, m: Pick<MachineSnapshot, 'id' | 'sweep'>, found: Survey, jobOf: (id: string) => Job | undefined, at: string): void {
  closeGone(store, m.id, found, at);
  const ledgered = new Set(store.resourceLedger.onMachine(m.id).map((e) => ledgerKey(e.jobId, e.kind, e.locator)));
  for (const e of unledgeredEntriesOf(found, ledgered, jobOf, m.id, m.sweep, Date.parse(at))) store.resourceLedger.record(e);
}

/**
 * The work trees the sweep surveys on machine `machineId` (issue #2504 parts 7, 8): `roots`, the ones the job list names, and
 * each one an entry there not yet reaped is in (kept work's too), so what only an older job left is surveyed too. Sorted, once each.
 */
export function sweptRoots(store: Ledger, machineId: string, roots: readonly string[]): string[] {
  return [...new Set([...roots, ...ledgerRootsOf(store.resourceLedger.onMachine(machineId), machineId)])].sort();
}
