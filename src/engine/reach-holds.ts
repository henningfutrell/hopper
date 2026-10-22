// A machine whose jobs cannot reach the hopper, as a job's start found it (issue #1920, design.md "GitHub through the
// hopper" → "The reach check"): the reach check of issue #695 runs only when a job starts, so a machine no probe reads
// (a client target, a box) is offered jobs that would all fail there. Once a start finds it so, the machine carries that
// problem (`addressProblem`) for a while, and the decider holds a new job there (src/decider/assign.ts `addressHolds`);
// the job that found it is queued again, to be placed elsewhere. The hold ends by itself: the next job placed there
// checks again. Kept in memory: a restart forgets it, and the next start there finds it again. Its problem says when the
// hold began and when it ends (issue #2427), so a wait that names the machine says that the hold ends by itself.
import type { Clock, MachineSource } from '../domain/ports.ts';

/** How long a machine a job's start found out of reach takes no new job, before a job is placed there to check again. */
export const REACH_HOLD_MS = 10 * 60_000;

export interface ReachHolds {
  /** The machine `machineId` cannot reach the hopper: `problem` says why, and what to do. */
  hold(machineId: string, problem: string): void;
  /** The machines, each one held carrying its problem (one a probe found a problem on keeps that one). */
  source(machines: MachineSource): MachineSource;
}

export function createReachHolds(clock: Clock, holdMs = REACH_HOLD_MS): ReachHolds {
  const held = new Map<string, { problem: string; until: number }>();
  const problemOf = (machineId: string): string | undefined => {
    const h = held.get(machineId);
    if (h && h.until <= clock.now().getTime()) held.delete(machineId);
    return held.get(machineId)?.problem;
  };
  return {
    hold(machineId, problem) {
      const at = clock.now().getTime(), until = at + holdMs;
      held.set(machineId, { problem: `${problem} (held since ${new Date(at).toISOString()}; a job placed there after ${new Date(until).toISOString()} checks again)`, until });
    },
    source: (machines) => ({
      list: async () => (await machines.list()).map((m) => {
        const addressProblem = m.addressProblem === undefined ? problemOf(m.id) : undefined;
        return addressProblem === undefined ? m : { ...m, addressProblem };
      }),
    }),
  };
}
