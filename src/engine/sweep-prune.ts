// The storage prune (issue #2494, design.md "Hopper's own disk use" → "Part 8"), the sweep's part beside sweep.ts for its
// size: on a machine with `sweep.pruneAfterDays`, a pass prunes its container storage once a day, or once an hour while its
// disk is low — the exited containers the hopper chose, the anonymous volumes no container uses, the images no container
// uses —, and records what it removed as one machine.storage_pruned event with the bytes. Off where the option is absent.
import type { MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import { containersToPrune, type PrunedItem } from '../domain/storage-prune.ts';
import type { EngineContext } from './context.ts';

/** How often a machine's storage is pruned; while its disk is low, `PRUNE_LOW_MS`. */
export const PRUNE_EVERY_MS = 24 * 3600_000;
export const PRUNE_LOW_MS = 3600_000;

export interface SweepPrune {
  /** Prunes the machine's container storage when it is due, from what the pass's survey `found`; the bytes it said it freed. Never throws. */
  pass(m: MachineSnapshot, shell: MachineShell, found: Survey): Promise<number>;
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

export function createPrune(c: Pick<EngineContext, 'store' | 'clock' | 'stopping'>, log: (line: string) => void): SweepPrune {
  /** When each machine was last pruned, and the machines whose prune failed, told once while it fails. */
  const last = new Map<string, number>();
  const failing = new Set<string>();
  return {
    async pass(m, shell, found) {
      const days = m.sweep?.pruneAfterDays;
      if (!days || !shell.prune) return 0;
      const now = c.clock.now().getTime();
      const at = last.get(m.id);
      if (at !== undefined && now - at < (m.disk?.low ? PRUNE_LOW_MS : PRUNE_EVERY_MS)) return 0;
      last.set(m.id, now);
      let removed: PrunedItem[];
      try {
        removed = (await shell.prune(days, containersToPrune(found.exited ?? [], days, now).map((x) => `${x.runtime}:${x.id}`))).removed;
        failing.delete(m.id);
      } catch (e) {
        if (!failing.has(m.id)) log(`hopper: the sweep could not prune the container storage on ${m.id}: ${(e as Error).message}`);
        failing.add(m.id);
        return 0;
      }
      const bytes = removed.reduce((n, r) => n + (r.bytes ?? 0), 0);
      if (c.stopping() || removed.length === 0) return bytes;
      const of = (kind: PrunedItem['kind']): number => removed.filter((r) => r.kind === kind).length;
      log(`hopper: the sweep pruned ${count(of('container'), 'container')}, ${count(of('volume'), 'volume')} and ${count(of('image'), 'image')} on ${m.id}, ${(bytes / 1e9).toFixed(1)} GB`);
      c.store.events.append({ type: 'machine.storage_pruned', machineId: m.id, data: { machineId: m.id, olderThanDays: days, bytes, removed } });
      return bytes;
    },
  };
}
