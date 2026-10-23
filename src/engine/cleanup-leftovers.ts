// The leftover check (issue #2504, design.md "The resource ledger"): with each sweep pass, an ended job whose ledger still
// holds an entry `live` or `failed` once the grace period after its end passed is a cleanup leftover, recorded once per job
// as `job.cleanup_leftover` and never ignored: Failures lists it as stuck work while it stays. Then each told entry on a
// retired machine (issue #919), which no reap reaches, is closed `retired` (part 12): the record stays, the leftover ends.
import { CLEANUP_GRACE_MINUTES, cleanupLeftoversOf, retiredClosures } from '../domain/resource-ledger.ts';
import type { EngineContext } from './context.ts';

/** Runs one leftover check. Never rejects. */
export type LeftoverCheck = () => Promise<void>;

export function createLeftoverCheck(c: Pick<EngineContext, 'store' | 'clock' | 'machines' | 'configuredMachines'>, log: (line: string) => void = (l) => console.warn(l)): LeftoverCheck {
  // The jobs already told, here or (read once) by an event before a restart: each is told once.
  const told = new Set<string>();
  return async () => {
    try {
      const leftovers = cleanupLeftoversOf(c.store.resourceLedger.open(), (id) => c.store.jobs.get(id), c.clock.now().getTime());
      for (const l of leftovers) {
        if (told.has(l.jobId)) continue;
        told.add(l.jobId);
        if (c.store.events.recent(1, ['job.cleanup_leftover'], l.jobId).length > 0) continue;
        log(`hopper: job ${l.jobId} ended at ${l.endedAt} and its cleanup left ${l.entries.map((e) => `${e.locator} on ${e.machineId} (${e.state})`).join(', ')}`);
        c.store.events.append({
          type: 'job.cleanup_leftover', jobId: l.jobId,
          data: { endedAt: l.endedAt, graceMinutes: CLEANUP_GRACE_MINUTES, entries: l.entries.map((e) => ({ machineId: e.machineId, kind: e.kind, locator: e.locator, state: e.state, ...(e.reason ? { reason: e.reason } : {}) })) },
        });
      }
      const retired = retiredClosures(leftovers, (await c.machines.list()).map((m) => m.id), c.configuredMachines());
      const at = c.clock.now().toISOString();
      for (const r of retired) {
        c.store.resourceLedger.close(r.entry.jobId, r.entry.kind, r.entry.locator, r.state, at, r.reason);
        log(`hopper: job ${r.entry.jobId}: its cleanup leftover ${r.entry.locator} is on ${r.entry.machineId}, a retired machine: closed retired`);
      }
    } catch (e) {
      log(`hopper: the leftover check failed: ${(e as Error).message}`);
    }
  };
}
