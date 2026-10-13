// The memory alert (issue #868, design.md "Machine resources over time" → "WSL and the memory alert"): at each record
// of the resource recorder it is shown every machine. A machine whose free memory — Windows' own for a WSL machine that
// reads it, else memory available — stayed under the user's threshold for the minutes set is told once
// (`machine.memory_low`), and once more when it is back over (`machine.memory_recovered`). A WSL machine that reads no
// Windows memory and a container are not watched: their memory available is not what the host has free. What it
// watches is kept in memory: after a restart a machine still low is told again. The alert off forgets it all.
import type { MachineSnapshot, MemoryAlert, ResourceReading } from '../domain/types.ts';

/** A machine's free memory, and whose: Windows' own (a WSL machine), or the machine's memory available. */
export type FreeMemory = { freeBytes: number; totalBytes: number; of: 'windows' | 'machine' };

export type MemoryAlertEvent =
  | { type: 'machine.memory_low'; machineId: string; data: { machineId: string; thresholdBytes: number; since: string } & FreeMemory }
  | { type: 'machine.memory_recovered'; machineId: string; data: { machineId: string; thresholdBytes: number } & FreeMemory };

/** The free memory the alert watches; undefined when the reading does not say what the host has free. */
export function freeMemoryOf(r: ResourceReading): FreeMemory | undefined {
  if (r.hostMemFreeBytes !== undefined && r.hostMemTotalBytes !== undefined) return { freeBytes: r.hostMemFreeBytes, totalBytes: r.hostMemTotalBytes, of: 'windows' };
  if (r.wsl || r.container) return undefined;
  return { freeBytes: r.memAvailableBytes, totalBytes: r.memTotalBytes, of: 'machine' };
}

export interface MemoryWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

export function createMemoryWatch(o: { alert: () => MemoryAlert | undefined; tell: (e: MemoryAlertEvent) => void }): MemoryWatch {
  /** Per machine: since when its free memory is under the threshold, and whether that was told. */
  const under = new Map<string, { since: string; told: boolean }>();
  return {
    observe(machines, at) {
      const alert = o.alert();
      if (!alert) { under.clear(); return; }
      const seen = new Set<string>();
      for (const m of machines) {
        const free = m.online && m.resources ? freeMemoryOf(m.resources) : undefined;
        if (!free) continue;
        seen.add(m.id);
        const was = under.get(m.id);
        if (free.freeBytes >= alert.freeBytes) {
          under.delete(m.id);
          if (was?.told) o.tell({ type: 'machine.memory_recovered', machineId: m.id, data: { machineId: m.id, ...free, thresholdBytes: alert.freeBytes } });
          continue;
        }
        const now = was ?? { since: at, told: false };
        under.set(m.id, now);
        if (!now.told && Date.parse(at) - Date.parse(now.since) >= alert.minutes * 60_000) {
          now.told = true;
          o.tell({ type: 'machine.memory_low', machineId: m.id, data: { machineId: m.id, ...free, thresholdBytes: alert.freeBytes, since: now.since } });
        }
      }
      // A machine offline or with no reading: a stretch under not yet told ends; one told waits for it to be back over.
      for (const [id, u] of [...under]) if (!seen.has(id) && !u.told) under.delete(id);
    },
  };
}
