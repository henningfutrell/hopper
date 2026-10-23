// The allocation failure watch (issue #2622 part 6, design.md "Machine resources over time" → "The allocation failure
// watch"): at each record of the resource recorder it is shown every machine. A machine whose kernel logged a burst of
// large page allocation failures (order 4 or more, ALLOC_FAILURE_BURST in the last 10 minutes: `memAllocFailures`) is told
// once (`machine.allocation_failures`), and once more when the last 10 minutes have none
// (`machine.allocation_failures_ended`). In a WSL VM they come before wsl.exe and interop hang: memory is full and
// fragmented. A machine offline or with no reading keeps what was told. Kept in memory, as the offline watch: after a
// restart of the hopper a burst still on is told again. A machine gone from the list is forgotten.
import type { MachineSnapshot } from '../domain/types.ts';

/** This many large page allocation failures in the last 10 minutes is a burst. */
export const ALLOC_FAILURE_BURST = 3;

type Machine = { machineId: string; label: string; since: string };
export type AllocFailureEvent =
  | { type: 'machine.allocation_failures'; machineId: string; data: Machine & { count: number; maxOrder: number } }
  | { type: 'machine.allocation_failures_ended'; machineId: string; data: Machine };

export interface AllocFailureWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

export function createAllocFailureWatch(o: { tell: (e: AllocFailureEvent) => void }): AllocFailureWatch {
  /** Per machine told of a burst: since when. */
  const told = new Map<string, string>();
  return {
    observe(machines, at) {
      const seen = new Set<string>();
      for (const m of machines) {
        seen.add(m.id);
        if (!m.online || !m.resources) continue;
        const fails = m.resources.memAllocFailures;
        const since = told.get(m.id);
        if (since === undefined && fails && fails.count >= ALLOC_FAILURE_BURST) {
          told.set(m.id, at);
          o.tell({ type: 'machine.allocation_failures', machineId: m.id, data: { machineId: m.id, label: m.label, count: fails.count, maxOrder: fails.maxOrder, since: at } });
        } else if (since !== undefined && !fails) {
          told.delete(m.id);
          o.tell({ type: 'machine.allocation_failures_ended', machineId: m.id, data: { machineId: m.id, label: m.label, since } });
        }
      }
      for (const id of [...told.keys()]) if (!seen.has(id)) told.delete(id);
    },
  };
}
