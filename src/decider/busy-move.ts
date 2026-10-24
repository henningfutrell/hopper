// The busy-machine move (issue #1977, design.md "The busy-machine move"), its pure part: a job queued to resume on its own
// machine (`resumeOn`, an answer pending) waits there while that machine has room. When every lane of it is in use and
// another machine that runs its executor has room, the move (src/engine/busy-move.ts) may take it there after a short
// wait. A person's or a routing rule's pin (`spec.machineId`) stays, and a job continued from a failure stays too: its
// agent session reopens in its kept work tree.
import type { Job, Lane, MachineSnapshot } from '../domain/types.ts';
import { windowsFits } from '../domain/windows-jobs.ts';

const inUse = (lanes: readonly Lane[], id: string): number => lanes.filter((l) => l.machineId === id && l.state !== 'idle').length;

/** Whether a job is one the move judges: queued to resume on its machine, by no pin of its spec, not moved already. */
export const resumesOnItsMachine = (job: Job): boolean => job.status === 'queued' && job.pendingAnswer !== undefined && job.resumeOn !== undefined
  && job.spec.machineId === undefined && job.parked?.elsewhere === undefined && job.continued === undefined;

/**
 * The machines with room a job resuming on a full machine may go to, in their order; undefined: it stays (it resumes on
 * no full machine, or no other machine has room). Room for a job not pinned there: its lane cap less its reserved lanes.
 */
export function busyMove(job: Job, machines: readonly MachineSnapshot[], lanes: readonly Lane[]): string[] | undefined {
  if (!resumesOnItsMachine(job)) return undefined;
  const from = machines.find((m) => m.id === job.resumeOn);
  if (!from?.online || inUse(lanes, from.id) < from.maxLanes) return undefined;
  const to = machines.filter((m) => m.id !== from.id && m.online && m.executors.includes(job.spec.executor) && windowsFits(m, job)
    && m.leaving !== true && m.drained === undefined && m.client?.updateHold === undefined && inUse(lanes, m.id) < m.maxLanes - (m.reservedLanes ?? 0)).map((m) => m.id);
  return to.length ? to : undefined;
}
