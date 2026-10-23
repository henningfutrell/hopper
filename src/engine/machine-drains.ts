// Drain a machine (issue #1511, design.md "Draining a machine"): a person stops new placement on one machine — for
// maintenance, a rebuild —, the jobs on it run to their end, and a person undrains it after. Kept in the user's settings
// (`machineDrains`), so a restart keeps it; each machine the engine lists carries it (`drained`), and the decider holds a
// new job there (src/decider/assign.ts `drainedHolds`). Issue #2499: a drain names why and ends by itself after its hours;
// the drain watch (src/machines/drain-watch.ts) ends it (`expire`), and a machine is listed drained only until its end.
import { DRAIN_DEFAULT_HOURS, drainEnds, withDrains } from '../domain/machines.ts';
import type { MachineSource } from '../domain/ports.ts';
import type { ActingPerson, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What a drain or an undrain answers: the machine, whether it is drained now, and the jobs still on it. */
export interface MachineDrainOutcome { machineId: string; drained: boolean; jobs: number }

/** Why a machine is drained, and for how many hours (absent: `DRAIN_DEFAULT_HOURS`). */
export interface DrainAsk { reason: string; hours?: number }

export interface MachineDrains {
  /**
   * Drain one machine (`drained: true`, with `ask`) or undrain it; `by` names who and the way. A no-op records nothing: a
   * drain of a drained machine keeps its reason and end. A drain with no reason is refused (issue #2499).
   */
  set(machineId: string, drained: boolean, by: ActingPerson, ask?: DrainAsk): Promise<MachineDrainOutcome>;
  /** End the drains of these machines that are past their end (issue #2499): one `machine.drain_expired` each. */
  expire(machineIds: readonly string[]): void;
}

/** The machines with the drained ones marked, read from the user's settings at each list; a drain past its end marks none. */
export const drainedMachines = (machines: MachineSource, c: Pick<EngineContext, 'store' | 'clock'>): MachineSource => ({
  list: async () => withDrains(await machines.list(), c.store.settings.getMachineDrains(), c.clock.now().toISOString()),
});

export function createMachineDrains(c: EngineContext): MachineDrains {
  // The jobs still on the machine: its lanes busy or draining with a job.
  const jobsOn = (machineId: string): number => c.store.lanes.list().filter((l) => l.machineId === machineId && l.jobId !== undefined).length;
  const known = (machines: MachineSnapshot[], machineId: string): boolean =>
    machines.some((m) => m.id === machineId) || (c.configuredMachines()?.includes(machineId) ?? false);
  return {
    async set(machineId, drained, by, ask) {
      const reason = ask?.reason.trim();
      if (drained && !reason) throw new EngineError('invalid', 'a drain names its reason');
      const drains = c.store.settings.getMachineDrains();
      const now = c.clock.now();
      const at = now.toISOString();
      const kept = drains[machineId];
      // A drain past its end that the watch has not ended yet: a new drain replaces it, an undrain clears it.
      const changes = drained ? !(kept && Date.parse(drainEnds(kept)) > now.getTime()) : kept !== undefined;
      // An undrain of a machine gone from the config still clears it, so nothing stale is kept.
      if (drained && !known(await c.machines.list(), machineId)) throw new EngineError('not_found', `machine ${machineId} not found`);
      if (changes) {
        const { [machineId]: _, ...rest } = drains;
        c.store.tx(() => {
          const until = new Date(now.getTime() + (ask?.hours ?? DRAIN_DEFAULT_HOURS) * 3_600_000).toISOString();
          c.store.settings.setMachineDrains(drained ? { ...rest, [machineId]: { ...by, at, reason: reason!, until } } : rest);
          c.store.events.append(drained
            ? { type: 'machine.drained', machineId, data: { machineId, ...by, reason: reason!, until } }
            : { type: 'machine.undrained', machineId, data: { machineId, ...by } });
        });
        c.trigger(drained ? `machine ${machineId} drained` : `machine ${machineId} undrained`);
      }
      return { machineId, drained, jobs: jobsOn(machineId) };
    },
    expire(machineIds) {
      const drains = c.store.settings.getMachineDrains();
      const now = c.clock.now().getTime();
      const over = machineIds.filter((id) => drains[id] !== undefined && Date.parse(drainEnds(drains[id])) <= now);
      if (!over.length) return;
      c.store.tx(() => {
        c.store.settings.setMachineDrains(Object.fromEntries(Object.entries(drains).filter(([id]) => !over.includes(id))));
        for (const id of over) {
          const d = drains[id]!;
          c.store.events.append({ type: 'machine.drain_expired', machineId: id, data: { machineId: id, person: d.person, via: d.via, at: d.at, until: drainEnds(d), ...(d.reason !== undefined ? { reason: d.reason } : {}) } });
        }
      });
      c.trigger(`drain of ${over.join(', ')} ended`);
    },
  };
}
