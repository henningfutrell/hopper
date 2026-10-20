// A machine's unhealthy lanes on Machines (issue #2234, src/engine/lane-health.ts): a lane whose last starts failed with the
// same start error takes no new job for a while. Pure: `now` is passed in.
import type { MachineSnapshot } from '../../../src/domain/types.ts';
import { countdown } from './format.ts';

export interface UnhealthyLaneLine { lane: string; text: string; error: string }

/** Each lane of the machine out at `now`: its name on the machine, what happened, and the last start error. */
export function unhealthyLaneLines(m: MachineSnapshot, now: number): UnhealthyLaneLine[] {
  return (m.unhealthyLanes ?? []).filter((l) => Date.parse(l.until) > now).map((l) => ({
    lane: l.laneId.slice(l.laneId.lastIndexOf('/') + 1),
    text: `${l.failures} starts in a row failed with the same start error; it takes no new job until it is tried again ${countdown(l.until, now)}`,
    error: l.error,
  }));
}
