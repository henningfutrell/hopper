// The offline watch (issue #1497, design.md "Machine resources over time" → "The offline watch"): at each record of the
// resource recorder it is shown every machine. A machine offline at every record for two minutes is told once
// (`machine.offline`), and once more when it is online again (`machine.back_online`), as the memory alert tells low
// memory. A container a host restart left stopped is told so, where webhooks and notifiers take it. Kept in memory:
// after a restart of the hopper a machine still offline is told again, two minutes after the hopper first sees it.
// A machine gone from the list is forgotten.
import type { MachineSnapshot } from '../domain/types.ts';

/** How long a machine stays offline before it is told. */
export const OFFLINE_AFTER_MS = 2 * 60_000;

type Machine = { machineId: string; label: string; since: string };
export type OfflineEvent =
  | { type: 'machine.offline'; machineId: string; data: Machine }
  | { type: 'machine.back_online'; machineId: string; data: Machine };

export interface OfflineWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

export function createOfflineWatch(o: { tell: (e: OfflineEvent) => void }): OfflineWatch {
  /** Per machine: since when it is offline, and whether that was told. */
  const offline = new Map<string, { since: string; told: boolean }>();
  return {
    observe(machines, at) {
      const seen = new Set<string>();
      for (const m of machines) {
        seen.add(m.id);
        const was = offline.get(m.id);
        if (m.online) {
          offline.delete(m.id);
          if (was?.told) o.tell({ type: 'machine.back_online', machineId: m.id, data: { machineId: m.id, label: m.label, since: was.since } });
          continue;
        }
        const now = was ?? { since: at, told: false };
        offline.set(m.id, now);
        if (!now.told && Date.parse(at) - Date.parse(now.since) >= OFFLINE_AFTER_MS) {
          now.told = true;
          o.tell({ type: 'machine.offline', machineId: m.id, data: { machineId: m.id, label: m.label, since: now.since } });
        }
      }
      for (const id of [...offline.keys()]) if (!seen.has(id)) offline.delete(id);
    },
  };
}
