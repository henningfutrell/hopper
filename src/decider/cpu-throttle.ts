// The CPU throttle (issue #2499, design.md "The memory floor", its CPU throttle): a machine whose CPU quota held its tasks back in
// CPU_THROTTLE_FRAC of its CPU periods or more, since its read before, takes no new job, and a wait says why. Pure.
import { CPU_THROTTLE_FRAC, type MachineSnapshot } from '../domain/types.ts';

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** Whether the machine's last reading shows its CPU quota throttling it at or above CPU_THROTTLE_FRAC. */
export const cpuThrottled = (m: MachineSnapshot): boolean => (m.resources?.cpuThrottledFrac ?? 0) >= CPU_THROTTLE_FRAC;

/** What the machine's CPU throttle holds against a new job. */
export const throttleShort = (m: MachineSnapshot): string =>
  `its CPU quota held its tasks back in ${pct(m.resources?.cpuThrottledFrac ?? 0)} of its periods lately, and a new job starts only below ${pct(CPU_THROTTLE_FRAC)}`;

/** The wait reason of a job whose memory these machines hold but whose CPU quota throttles each of them. */
export const cpuWait = (machines: readonly MachineSnapshot[]): string =>
  `waiting for CPU: ${machines.map((m) => `${m.id}'s ${throttleShort(m).slice(4)}`).join('; ')}`;
