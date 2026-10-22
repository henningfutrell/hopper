// When the sweep is due on a machine (issue #410, design.md "Work tree" → "The sweep"): every `sweep.everyMinutes` (a
// machine option, default 10), and at once when its disk turns low (issue #2490, design.md "A machine's disk"), then by
// its interval while it stays low. Kept in memory: after a restart, the first pass sweeps every machine.
import type { MachineSnapshot } from '../domain/types.ts';

export const SWEEP_EVERY_MINUTES = 10;

const minutes = (m: MachineSnapshot): number => m.sweep?.everyMinutes ?? SWEEP_EVERY_MINUTES;

export interface SweepDue {
  /** The online machines, not container targets, whose sweep is due at `now` (`all`: every one). */
  due(machines: readonly MachineSnapshot[], now: number, all: boolean): MachineSnapshot[];
  /** The machine swept at `now`. */
  swept(m: MachineSnapshot, now: number): void;
}

export function createSweepDue(): SweepDue {
  const last = new Map<string, number>();
  /** The machines whose disk is low that were swept since it turned low. */
  const lowSwept = new Set<string>();
  return {
    due(machines, now, all) {
      for (const m of machines) if (!m.disk?.low) lowSwept.delete(m.id);
      const turnedLow = (m: MachineSnapshot): boolean => m.disk?.low === true && !lowSwept.has(m.id);
      return machines.filter((m) => m.online && !m.containerImage && (all || turnedLow(m) || now - (last.get(m.id) ?? -Infinity) >= minutes(m) * 60_000));
    },
    swept(m, now) {
      last.set(m.id, now);
      if (m.disk?.low) lowSwept.add(m.id);
    },
  };
}
