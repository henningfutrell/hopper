// The raising machine (issue #485, glossary "Raising machine"): which machine a question was asked on,
// worked out the one way for the engine as it asks and for the migration that fills older questions.
import type { LaneId, MachineId, RaisedBy } from './types.ts';

/** The machine a lane id names (`${machineId}/lane-${n}`); undefined for anything else. */
export function machineOfLane(laneId: LaneId | undefined): MachineId | undefined {
  const i = laneId?.lastIndexOf('/lane-') ?? -1;
  return i > 0 ? laneId!.slice(0, i) : undefined;
}

/**
 * The snapshot: the asking lane's machine, else the job's `resumeOn`, else its machine pin. `machines` are
 * the machines known now, by id with their label: the name is taken from the one it names, if any.
 */
export function raisedBy(o: {
  laneId?: LaneId; resumeOn?: MachineId; pin?: MachineId; machines: ReadonlyMap<MachineId, string>;
}): RaisedBy | undefined {
  const fromLane = machineOfLane(o.laneId);
  const machineId = fromLane ?? o.resumeOn ?? o.pin;
  if (!machineId) return undefined;
  const name = o.machines.get(machineId);
  return { machineId, ...(name ? { name } : {}), ...(fromLane ? { laneId: o.laneId } : {}) };
}
