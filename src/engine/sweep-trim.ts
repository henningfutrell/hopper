// The trim (issue #2494, design.md "Hopper's own disk use" → "Part 9"), the sweep's part beside sweep.ts for its size: on a
// machine with `sweep.trimAboveGiB`, the sweep adds up what its passes freed there — the storage prune's bytes, and the drop
// of the hopper's own disk use its reaps made, measured again after them —, and once the sum reaches the option, it runs
// fstrim there (src/client/trim.ts), records the result as one machine.disk_trim_ran event, and starts the sum again from
// nothing. In a WSL distro the event says so: the virtual disk on the host shrinks only by a compaction there, which the
// hopper cannot run from inside. Off where the option is absent.
import type { MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import type { Trimmed } from '../domain/disk-trim.ts';
import type { EngineContext } from './context.ts';

const GIB = 1024 ** 3;

export interface SweepTrim {
  /** Adds `freed` bytes to what the machine's cleanups freed, and trims there when the sum reaches its option. Never throws. */
  pass(m: MachineSnapshot, shell: MachineShell, freed: number): Promise<void>;
}

const used = (s: Survey): number => (s.usage ?? []).reduce((n, u) => n + u.bytes, 0);
/** What the reaps of a pass freed: the drop of the hopper's own disk use from the pass's first survey to the one after them. */
export const freedBetween = (found: Survey, after: Survey): number => (found === after ? 0 : Math.max(0, used(found) - used(after)));

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export function createTrim(c: Pick<EngineContext, 'store' | 'stopping'>, log: (line: string) => void): SweepTrim {
  /** What each machine's cleanups freed since its last trim, and the machines whose trim failed, told once while it fails. */
  const freedSince = new Map<string, number>();
  const failing = new Set<string>();
  return {
    async pass(m, shell, freed) {
      const gib = m.sweep?.trimAboveGiB;
      if (!gib || !shell.trim) return;
      const sum = (freedSince.get(m.id) ?? 0) + Math.max(0, freed);
      if (sum < gib * GIB) { freedSince.set(m.id, sum); return; }
      freedSince.delete(m.id);
      let t: Trimmed;
      try {
        t = await shell.trim();
        failing.delete(m.id);
      } catch (e) {
        if (!failing.has(m.id)) log(`hopper: the sweep could not run fstrim on ${m.id}: ${(e as Error).message}`);
        failing.add(m.id);
        return;
      }
      if (c.stopping()) return;
      const host = t.wsl ? '; the host\'s virtual disk shrinks only once it is compacted there' : '';
      const result = t.outcome === 'trimmed' ? `${t.bytes !== undefined ? gb(t.bytes) : 'an unknown size'} trimmed` : `${t.outcome}${t.said ? ` (${t.said})` : ''}`;
      log(`hopper: the sweep ran fstrim on ${m.id} (${t.mount}): ${result}, after its cleanups freed ${gb(sum)}${host}`);
      c.store.events.append({
        type: 'machine.disk_trim_ran', machineId: m.id,
        data: {
          machineId: m.id, freedBytes: sum, mount: t.mount, outcome: t.outcome,
          ...(t.bytes !== undefined ? { trimmedBytes: t.bytes } : {}), ...(t.said ? { said: t.said } : {}), ...(t.wsl ? { hostCompaction: true } : {}),
        },
      });
    },
  };
}
