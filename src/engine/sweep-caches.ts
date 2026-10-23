// The cache caps (issue #2494, design.md "Hopper's own disk use" → "Part 10"), the sweep's part beside sweep.ts for its
// size: on a machine with `sweep.cacheCapsGiB`, a pass clears each kind of cache whose places the survey found over its
// cap — or, while the disk there is low, each kind with a cap — and records what it removed as one machine.caches_cleared
// event with the bytes. Only while no job there may use them: a job that has not ended on that machine, or a scope or
// process of a job the pass's survey found. Jobs never wait on it. At most once an hour on each machine.
import type { JobStatus, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import { cachesInUse, cachesToClear, type ClearedCache } from '../domain/cache-caps.ts';
import type { EngineContext } from './context.ts';

/** How often a machine's caches may be cleared. */
export const CLEAR_EVERY_MS = 3600_000;

export interface SweepCaches {
  /** Clears the machine's caches over their caps, from what the pass's survey `found`; the bytes it freed. Never throws. */
  pass(m: MachineSnapshot, shell: MachineShell, found: Survey): Promise<number>;
}

/** Every status of a job that has not ended. */
const OPEN: JobStatus[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'parked', 'waiting_on'];

export function createCaches(c: Pick<EngineContext, 'store' | 'clock' | 'stopping'>, log: (line: string) => void): SweepCaches {
  /** When each machine's caches were last cleared; the machines whose clear failed, and those a job kept, each told once while it lasts. */
  const last = new Map<string, number>();
  const failing = new Set<string>(), busy = new Set<string>();
  return {
    async pass(m, shell, found) {
      const kinds = cachesToClear(m.sweep?.cacheCapsGiB, found.caches ?? [], m.disk?.low === true);
      if (kinds.length === 0 || !shell.clearCaches) { busy.delete(m.id); return 0; }
      const now = c.clock.now().getTime();
      const at = last.get(m.id);
      if (at !== undefined && now - at < CLEAR_EVERY_MS) return 0;
      // Read now, just before the clear: a job may have started there since the pass began.
      const why = cachesInUse(m.id, c.store.jobs.list({ status: OPEN }), [...found.scopes, ...found.processes]);
      if (why) {
        if (!busy.has(m.id)) log(`hopper: the sweep leaves the ${kinds.join(', ')} caches on ${m.id} over their cap for now: ${why}`);
        busy.add(m.id);
        return 0;
      }
      busy.delete(m.id);
      last.set(m.id, now);
      let removed: ClearedCache[];
      try {
        const said = await shell.clearCaches(kinds);
        removed = said.removed.map((r) => ({ ...r, bytes: found.caches?.find((x) => x.path === r.path)?.bytes ?? 0 }));
        failing.delete(m.id);
      } catch (e) {
        if (!failing.has(m.id)) log(`hopper: the sweep could not clear the caches on ${m.id}: ${(e as Error).message}`);
        failing.add(m.id);
        return 0;
      }
      const bytes = removed.reduce((n, r) => n + r.bytes, 0);
      if (c.stopping() || removed.length === 0) return bytes;
      log(`hopper: the sweep cleared the ${[...new Set(removed.map((r) => r.kind))].join(', ')} caches on ${m.id}, ${(bytes / 1e9).toFixed(1)} GB`);
      c.store.events.append({ type: 'machine.caches_cleared', machineId: m.id, data: { machineId: m.id, bytes, removed, ...(m.disk?.low ? { low: true } : {}) } });
      return bytes;
    },
  };
}
