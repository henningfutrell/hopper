// Where a specialty job may elbow in (issue #762, design.md "Specialty jobs elbow in"): past the machine's lane cap,
// within its elbow-ins, never at a usage hard limit or under resource pressure (a CPU throttle too, issue #2499). Pure, like the rest of the decider.
import { CPU_THROTTLE_FRAC, RESOURCE_PRESSURE } from '../domain/lane-tuning.ts';
import { elbowInsOf } from '../domain/elbow-in.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import type { CapBand } from './usage.ts';

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** Why the machine's last resource reading shows pressure (lane tuning's thresholds), or undefined. */
export function resourcePressure(m: MachineSnapshot): string | undefined {
  const r = m.resources;
  if (!r) return undefined;
  if (r.cpuBusyFrac !== undefined && r.cpuBusyFrac >= RESOURCE_PRESSURE.cpu) return `CPU ${pct(r.cpuBusyFrac)} busy`;
  if (r.cpuThrottledFrac !== undefined && r.cpuThrottledFrac >= CPU_THROTTLE_FRAC) return `CPU throttled in ${pct(r.cpuThrottledFrac)} of its periods`;
  const memUsed = r.memTotalBytes > 0 ? 1 - r.memAvailableBytes / r.memTotalBytes : 0;
  return memUsed >= RESOURCE_PRESSURE.memory ? `memory ${pct(memUsed)} used` : undefined;
}

/**
 * Whether one more lane past the cap fits there: below the cap plus its elbow-ins, with neither the machine nor the
 * job's executor at its usage hard limit, and no resource pressure. The caller checks the job may run there at all.
 */
export function roomToElbowIn(s: { machine: MachineSnapshot; cap: number; band: CapBand; occupied: number; assigned: number }, executorBand: CapBand): boolean {
  return s.band !== 'hard' && executorBand !== 'hard' && resourcePressure(s.machine) === undefined
    && s.occupied + s.assigned < s.cap + elbowInsOf(s.machine);
}
