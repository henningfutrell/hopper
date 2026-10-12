// A retired machine (issue #919): one removed from the plugins config, that no machine source lists any more. A waiting
// job pinned to it, or resuming there, would wait for it for good; the engine fails it instead, in the pass that sees it.
// A machine still in the config is never retired, though its instance did not build: that is a fault to fix, not a retire.
import type { Job, MachineSnapshot } from '../domain/types.ts';
import { pinOf } from './assign.ts';

export interface RetiredPin { jobId: string; machineId: string; reason: string }

export const retiredReason = (machineId: string): string =>
  `pinned machine ${machineId} is retired: it is no longer configured. Run the job again to place it on another machine`;

/** Pure: the waiting jobs (queued or held) whose pin names a machine neither in `machines` nor in `configured`. */
export function retiredPins(waiting: readonly Job[], machines: readonly MachineSnapshot[], configured: readonly string[]): RetiredPin[] {
  const listed = new Set([...machines.map((m) => m.id), ...configured]);
  return waiting.flatMap((job) => {
    if (job.status !== 'queued' && job.status !== 'held') return [];
    const pin = pinOf(job);
    return pin === undefined || listed.has(pin) ? [] : [{ jobId: job.id, machineId: pin, reason: retiredReason(pin) }];
  });
}
