// The drain watch (issue #2499, design.md "Draining a machine"): at each record of the resource recorder it is shown every
// machine. A drain past its end (`drainEnds`) is ended (`expire`). A drained machine that is online, has a free lane under
// its lane cap, and runs the executor of a queued job, for `DRAINED_IDLE_AFTER_MS`, is told once (`machine.drained_idle`):
// work waits while a person's hold keeps a machine idle. Its stretch ends when one of these stops; a new stretch is told
// again. The queued jobs are read only while some drained machine has a free lane. Kept in memory: after a restart a
// machine still idle is told again.
import { drainEnds, DRAINED_IDLE_AFTER_MS, type MachineDrains } from '../domain/machines.ts';
import type { Job, Lane, MachineSnapshot } from '../domain/types.ts';

export type DrainWatchEvent = {
  type: 'machine.drained_idle'; machineId: string;
  data: { machineId: string; label: string; since: string; drainedAt: string; until: string; reason?: string; freeLanes: number; queued: number };
};

export interface DrainWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

export function createDrainWatch(o: {
  drains: () => MachineDrains;
  queued: () => readonly Job[];
  lanes: () => readonly Lane[];
  /** End these drains: each is past its end. */
  expire: (machineIds: readonly string[]) => void;
  tell: (e: DrainWatchEvent) => void;
}): DrainWatch {
  /** Per machine: since when it is drained and idle with a backlog, and whether that was told. */
  const idle = new Map<string, { since: string; told: boolean }>();
  return {
    observe(machines, at) {
      const now = Date.parse(at);
      const drains = o.drains();
      const over = Object.entries(drains).filter(([, d]) => Date.parse(drainEnds(d)) <= now).map(([id]) => id).sort();
      if (over.length) o.expire(over);
      const lanes = o.lanes();
      const free = machines.flatMap((m) => {
        const d = drains[m.id];
        if (!d || over.includes(m.id) || !m.online) return [];
        const n = m.maxLanes - lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').length;
        return n > 0 ? [{ m, d, n }] : [];
      });
      const queued = free.length ? o.queued() : [];
      const seen = new Set<string>();
      for (const { m, d, n } of free) {
        const count = queued.filter((j) => m.executors.includes(j.spec.executor)).length;
        if (count === 0) continue;
        seen.add(m.id);
        const was = idle.get(m.id) ?? { since: at, told: false };
        idle.set(m.id, was);
        if (was.told || now - Date.parse(was.since) < DRAINED_IDLE_AFTER_MS) continue;
        was.told = true;
        o.tell({
          type: 'machine.drained_idle', machineId: m.id,
          data: { machineId: m.id, label: m.label, since: was.since, drainedAt: d.at, until: drainEnds(d), ...(d.reason !== undefined ? { reason: d.reason } : {}), freeLanes: n, queued: count },
        });
      }
      for (const id of [...idle.keys()]) if (!seen.has(id)) idle.delete(id);
    },
  };
}
