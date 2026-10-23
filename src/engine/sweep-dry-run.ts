// The sweep's dry run (issue #2494, design.md "Hopper's own disk use" → "Part 14"), the sweep's part beside sweep.ts for its
// size: on a machine whose `sweep.dryRun` is on, a pass reaps, prunes, clears and trims nothing there; it records what it
// would remove (src/domain/sweep-dry-run.ts) as one machine.sweep_dry_run event, and again only once that changes. A
// person's discard still runs: it is a person's act, not the sweep's.
import type { MachineSnapshot } from '../domain/types.ts';
import type { Survey } from '../domain/ports.ts';
import { dryRunOf } from '../domain/sweep-dry-run.ts';
import type { EngineContext } from './context.ts';

export interface SweepDryRunPass {
  /** Records what the pass would remove on the machine, from its survey `found` and its plan, unless it said the same last. */
  pass(m: MachineSnapshot, found: Survey, plan: readonly { jobId: string; scratch?: string }[], kept: ReadonlySet<string>): void;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export function createDryRun(c: Pick<EngineContext, 'store' | 'clock' | 'stopping'>, log: (line: string) => void): SweepDryRunPass {
  /** What each machine's dry run last said, as JSON: in memory, so a restart says it once more. */
  const last = new Map<string, string>();
  return {
    pass(m, found, plan, kept) {
      if (c.stopping()) return;
      const d = dryRunOf(m, found, plan, kept, c.clock.now().getTime()), text = JSON.stringify(d);
      if (last.get(m.id) === text) return;
      last.set(m.id, text);
      log(`hopper: dry run on ${m.id}: the sweep would reap ${d.reaps.length} scratch dir(s) (${gb(d.reapBytes)}) and clear ${gb(d.cacheBytes)} of caches${d.prune ? `, prune ${d.prune.containers.length} container(s) and up to ${gb(d.prune.reclaimableBytes)}` : ''}; it removed nothing`);
      c.store.events.append({ type: 'machine.sweep_dry_run', machineId: m.id, data: { ...d } });
    },
  };
}

