// The resource ledger's writes (issue #2504, design.md "The resource ledger"): entries recorded from what a job's executor
// saved, and closed as each reap — the cleanup at the job's end, the sweep, a discard — says.
import { ledgerEntriesOf, reapClosures } from '../domain/resource-ledger.ts';
import type { Reaped } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';

type Ledger = Pick<UserStore, 'resourceLedger'>;

/** The entries the executor's saved state names, recorded on machine `machineId`; one already there is kept as it is. */
export function recordLedger(store: Ledger, jobId: string, machineId: string, state: unknown, at: string): void {
  for (const e of ledgerEntriesOf(jobId, machineId, state, at)) store.resourceLedger.record(e);
}

/** The job's entries closed as the reap said; `scratch` false: it did not look at the scratch dir, so only its scope. */
export function closeLedger(store: Ledger, jobId: string, said: Reaped, at: string, scratch = true): void {
  for (const c of reapClosures(store.resourceLedger.forJob(jobId), said, scratch)) store.resourceLedger.close(jobId, c.entry.kind, c.entry.locator, c.state, at, c.reason);
}
