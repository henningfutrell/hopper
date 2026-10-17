// Drain a machine (issue #1511, design.md "Draining a machine"): a person stops new placement on one machine — for
// maintenance, a rebuild —, the jobs on it run to their end, and a person undrains it after. Kept in the user's settings
// (`machineDrains`), so a restart keeps it; each machine the engine lists carries it (`drained`), and the decider holds a
// new job there (src/decider/assign.ts `drainedHolds`).
import { withDrains } from '../domain/machines.ts';
import type { MachineSource } from '../domain/ports.ts';
import type { ActingPerson, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What a drain or an undrain answers: the machine, whether it is drained now, and the jobs still on it. */
export interface MachineDrainOutcome { machineId: string; drained: boolean; jobs: number }

export interface MachineDrains {
  /** Drain one machine (`drained: true`) or undrain it; `by` names who and the way. A no-op records nothing. */
  set(machineId: string, drained: boolean, by: ActingPerson): Promise<MachineDrainOutcome>;
}

/** The machines with the drained ones marked, read from the user's settings at each list. */
export const drainedMachines = (machines: MachineSource, c: Pick<EngineContext, 'store'>): MachineSource => ({
  list: async () => withDrains(await machines.list(), c.store.settings.getMachineDrains()),
});

export function createMachineDrains(c: EngineContext): MachineDrains {
  // The jobs still on the machine: its lanes busy or draining with a job.
  const jobsOn = (machineId: string): number => c.store.lanes.list().filter((l) => l.machineId === machineId && l.jobId !== undefined).length;
  const known = (machines: MachineSnapshot[], machineId: string): boolean =>
    machines.some((m) => m.id === machineId) || (c.configuredMachines()?.includes(machineId) ?? false);
  return {
    async set(machineId, drained, by) {
      const drains = c.store.settings.getMachineDrains();
      const was = drains[machineId] !== undefined;
      // An undrain of a machine gone from the config still clears it, so nothing stale is kept.
      if (drained && !known(await c.machines.list(), machineId)) throw new EngineError('not_found', `machine ${machineId} not found`);
      if (was !== drained) {
        const { [machineId]: _, ...rest } = drains;
        c.store.tx(() => {
          c.store.settings.setMachineDrains(drained ? { ...rest, [machineId]: { ...by, at: c.clock.now().toISOString() } } : rest);
          c.store.events.append({ type: drained ? 'machine.drained' : 'machine.undrained', machineId, data: { machineId, ...by } });
        });
        c.trigger(drained ? `machine ${machineId} drained` : `machine ${machineId} undrained`);
      }
      return { machineId, drained, jobs: jobsOn(machineId) };
    },
  };
}
