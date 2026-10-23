// The maids (issue #2504 part 14, design.md "The resource ledger"): with each sweep check, each cleanup item due — a ledger
// entry of an ended job still `live` or `failed` once its own cleanup is over — is reaped through its machine's own shell
// (this machine, ssh, a client target), one reap per job and machine. The reap closes what it removed; what it kept for
// work not pushed is `kept` and `job.work_kept`; an entry it did not close, or a machine it did not reach, is an attempt
// on the entry, tried again after a backoff. The attempts are kept on the entries, so a restart goes on from them. A reap
// stops and removes only what is already gone or still there, so a second one frees nothing twice.
import { maidRetryMs, maidScratchOf, maidWorkOf, type MaidWork } from '../domain/maids.ts';
import type { MachineShell, Reaped } from '../domain/ports.ts';
import { reapClosures, type LedgerEntry } from '../domain/resource-ledger.ts';
import { keptData, type MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

/** Runs one pass of the maids; a pass while one runs does nothing. Never rejects. */
export type Maids = () => Promise<void>;

export function createMaids(c: Pick<EngineContext, 'store' | 'clock' | 'machines' | 'executors' | 'stopping'>, log: (line: string) => void = (l) => console.warn(l)): Maids {
  let busy = false;

  /** The machine as the first executor there that reaches it does, as the sweep reaches it. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };

  /** An attempt on each entry that did not close: failed with why, tried again after its backoff. */
  const tried = (entries: readonly LedgerEntry[], reason: (e: LedgerEntry) => string): void => {
    const now = c.clock.now().getTime(), at = new Date(now).toISOString();
    for (const e of entries) c.store.resourceLedger.tried(e.jobId, e.kind, e.locator, at, reason(e), new Date(now + maidRetryMs((e.attempts ?? 0) + 1)).toISOString());
  };

  /** What the reap said, on the store: each entry it closed, closed; the others, an attempt. */
  function record(w: MaidWork, said: Reaped, scratch: boolean): void {
    const closures = reapClosures(w.entries, said, scratch);
    const at = c.clock.now().toISOString();
    c.store.tx(() => {
      if (closures.some((x) => x.state === 'kept')) c.store.events.append({ type: 'job.work_kept', jobId: w.jobId, data: keptData(said, said.kept) });
      const open: LedgerEntry[] = [];
      for (const e of w.entries) {
        const to = closures.find((x) => x.entry === e);
        if (to && to.state !== 'failed') c.store.resourceLedger.close(e.jobId, e.kind, e.locator, to.state, at, to.reason);
        else open.push(e);
      }
      tried(open, (e) => closures.find((x) => x.entry === e)?.reason ?? (scratch ? e.reason ?? 'the reap did not remove it' : 'its scratch dir is not known, so the reap did not look at it'));
    });
  }

  async function tidy(w: MaidWork, m: MachineSnapshot): Promise<void> {
    const shell = m.online ? shellOf(m) : undefined;
    if (!shell) {
      tried(w.entries, () => (m.online ? `no executor reaches its machine ${m.id}` : `its machine ${m.id} is offline`));
      return;
    }
    const scratch = maidScratchOf(c.store.resourceLedger.forJob(w.jobId), w.jobId, w.machineId);
    let said: Reaped;
    try {
      said = await shell.reap(w.jobId, scratch);
    } catch (e) {
      if (c.stopping()) return;
      const error = (e as Error).message;
      log(`hopper: the maids could not reap job ${w.jobId} on ${m.id}: ${error}`);
      tried(w.entries, () => `the reap on ${m.id} failed: ${error}`);
      return;
    }
    if (c.stopping()) return;
    record(w, said, scratch !== undefined);
  }

  return async () => {
    if (busy || c.stopping()) return;
    busy = true;
    try {
      const work = maidWorkOf(c.store.resourceLedger.open(), (id) => c.store.jobs.get(id), c.clock.now().getTime());
      if (work.length === 0) return;
      const machines = await c.machines.list();
      for (const w of work) {
        if (c.stopping()) return;
        const m = machines.find((x) => x.id === w.machineId);
        // A machine no source lists: the leftover check tells it, and closes it retired once it is no longer configured.
        // A machine on a dry run: its sweep removes nothing, so neither do the maids.
        if (!m || m.sweep?.dryRun) continue;
        await tidy(w, m);
      }
    } catch (e) {
      log(`hopper: the maids failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
}
