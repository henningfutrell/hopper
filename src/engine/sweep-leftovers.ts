// Leftovers (issue #1116, design.md "Leftovers a person decides"), the sweep's part beside sweep.ts for its size: after its
// reaps, each pass lists what the layout before issue #1188 left in the `.hopper-scratch` of each work tree the survey found,
// and keeps, in memory, the leftovers it does not judge. A person keeps or removes each one; the sweep removes none by itself.
import type { ActingPerson, Job, Leftover, MachineLeftovers, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell } from '../domain/ports.ts';
import { LEFTOVER_EVENTS, unjudged, withDecisions } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** The decision trail read back: the newest this many events. */
const DECISION_EVENTS = 1000;

export interface SweepLeftovers {
  /** Lists the leftovers in `roots` on the machine; those the sweep does not judge are kept. Never throws. */
  list(m: MachineSnapshot, shell: MachineShell, roots: string[], jobOf: (id: string) => Job | undefined): Promise<void>;
  /** The machine's last listing, with the decisions that stand; undefined: none listed. */
  view(machineId: string): MachineLeftovers | undefined;
  /** A person keeps or removes one leftover listed on the machine (`Sweep.decideLeftover`). */
  decide(machineId: string, path: string, decision: 'keep' | 'remove', by: ActingPerson): Promise<{ machineId: string; path: string; decision: 'keep' | 'remove' }>;
}

export function createLeftovers(c: Pick<EngineContext, 'store' | 'machines' | 'clock'>, shellOf: (m: MachineSnapshot) => MachineShell | undefined, log: (line: string) => void): SweepLeftovers {
  /** Each machine's last listing, and the machines whose listing failed, told once while it fails. */
  const listed = new Map<string, { at: string; items: Leftover[] }>();
  const unlisted = new Set<string>();

  const drop = (machineId: string, path: string): void => {
    const l = listed.get(machineId);
    if (!l) return;
    const items = l.items.filter((x) => x.path !== path);
    if (items.length === 0) listed.delete(machineId);
    else listed.set(machineId, { ...l, items });
  };

  return {
    async list(m, shell, roots, jobOf) {
      if (!shell.leftovers || roots.length === 0) { listed.delete(m.id); return; }
      let found: Leftover[];
      try {
        found = await shell.leftovers(roots);
      } catch (e) {
        // A client older than this lists none; any other failure keeps the last listing.
        if (/runs an older client release/.test((e as Error).message)) { listed.delete(m.id); return; }
        if (!unlisted.has(m.id)) log(`hopper: the sweep could not list the leftovers on ${m.id}: ${(e as Error).message}`);
        unlisted.add(m.id);
        return;
      }
      unlisted.delete(m.id);
      const items = unjudged(found, jobOf);
      if (items.length === 0) listed.delete(m.id);
      else listed.set(m.id, { at: c.clock.now().toISOString(), items });
    },
    view(machineId) {
      const l = listed.get(machineId);
      return l ? { at: l.at, items: withDecisions(machineId, l.items, c.store.events.recent(DECISION_EVENTS, [...LEFTOVER_EVENTS])) } : undefined;
    },
    async decide(machineId, path, decision, by) {
      const m = (await c.machines.list()).find((x) => x.id === machineId);
      if (!m) throw new EngineError('not_found', `machine ${machineId} not found`);
      const item = listed.get(machineId)?.items.find((l) => l.path === path);
      if (!item) throw new EngineError('conflict', `${path} is no leftover the sweep listed on ${machineId}`);
      if (decision === 'keep') {
        c.store.events.append({ type: 'machine.leftover_kept', machineId, data: { machineId, path, ...by } });
        return { machineId, path, decision };
      }
      if (!m.online) throw new EngineError('conflict', `${path} cannot be removed: its machine ${machineId} is offline`);
      const shell = shellOf(m);
      if (!shell?.removeLeftover) throw new EngineError('conflict', `${path} cannot be removed: no executor reaches its machine ${machineId}`);
      let said;
      try {
        said = await shell.removeLeftover(path);
      } catch (e) {
        throw new EngineError('conflict', `${path} was not removed on ${machineId}: ${(e as Error).message}`);
      }
      if (said === 'left') throw new EngineError('conflict', `${path} is still there on ${machineId}: it could not be removed (a link, or files it may not remove)`);
      drop(machineId, path);
      log(`hopper: a person removed the leftover ${path} on ${machineId}${item.unpushed ? ', with its work not pushed' : ''}`);
      c.store.events.append({ type: 'machine.leftover_removed', machineId, data: { machineId, path, unpushed: item.unpushed, ...(item.bytes !== undefined ? { bytes: item.bytes } : {}), ...(said === 'gone' ? { gone: true } : {}), ...by } });
      return { machineId, path, decision };
    },
  };
}
