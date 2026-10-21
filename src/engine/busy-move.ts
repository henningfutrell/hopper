// The busy-machine move (issue #1977, design.md "The busy-machine move"): on each tick, a job queued to resume on its own
// machine, where every lane is in use, waits there `RESUME_WAIT_MS` at most while another machine that runs its executor has
// room (`busyMove`, src/decider/busy-move.ts). Then it goes on there, with no person, as the signed-out move takes a job: from
// its checkpoint, picked up to resume elsewhere (`recordUnpark`, elsewhere), or, when its agent never got its task, queued as
// a new start, not pinned. The hopper parks it first (`recordPark`, auto, with why), so nothing claims it meanwhile; a job
// whose answer waits in its live pane gets its pane and agent ended (`Executor.park`) and one more checkpoint. A job the move
// cannot checkpoint, or whose checkpoint holds work but no agent session, stays on its machine and is tried again after a while.
import { busyMove, resumesOnItsMachine } from '../decider/busy-move.ts';
import type { Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { finishLeftMoves, finishMove } from './move-finish.ts';
import { recordPark } from './park.ts';
import { howToMove, MOVE_RETRY_MS } from './signed-out-move.ts';

/** How long a resuming job waits for a lane on its own full machine while another machine has room. */
export const RESUME_WAIT_MS = 5 * 60_000;
/** How often the engine runs the pass: a statement on each tick holds a busy hopper's event loop. */
export const BUSY_MOVE_EVERY_MS = 10_000;

/** The busy-machine move: one pass over the queued jobs. */
export function createBusyMove(c: EngineContext): () => Promise<void> {
  /** Since when each job has waited on its full machine while another had room. */
  const since = new Map<string, number>();
  /** When each job last failed to move. */
  const tried = new Map<string, number>();
  return async function move(): Promise<void> {
    const { store } = c;
    const now = c.clock.now().getTime();
    for (const [id, at] of tried) if (now - at >= MOVE_RETRY_MS) tried.delete(id);
    // A move a stop cut short first (issue #1892).
    if (await finishLeftMoves(c, 'busy_machine')) c.trigger('busy_machine.move');
    const queued = store.jobs.list({ status: ['queued'] }).filter(resumesOnItsMachine);
    const seen = new Set(queued.map((j) => j.id));
    for (const id of since.keys()) if (!seen.has(id)) since.delete(id);
    if (queued.length === 0) return;
    const machines = await c.machines.list();
    const lanes = store.lanes.list();
    for (const waiting of queued) {
      if (c.stopping()) return;
      const to = busyMove(waiting, machines, lanes);
      if (!to) {
        since.delete(waiting.id);
        continue;
      }
      const first = since.get(waiting.id) ?? now;
      since.set(waiting.id, first);
      if (now - first < RESUME_WAIT_MS || tried.has(waiting.id)) continue;
      const how = await howToMove(c, waiting, `waits for a lane on ${waiting.resumeOn}`);
      if (!how) {
        tried.set(waiting.id, now);
        continue;
      }
      const from = waiting.resumeOn!;
      const why = `every lane of ${from} was in use for ${Math.round(RESUME_WAIT_MS / 60_000)} min, and ${to.join(', ')} ${to.length > 1 ? 'have' : 'has'} room: it resumes elsewhere`;
      const live = waiting.parked === undefined;
      const parked = store.tx((): Job | undefined => {
        // Read again in the tx: a Decision may have claimed it meanwhile.
        const job = store.jobs.get(waiting.id);
        if (!job || !busyMove(job, machines, store.lanes.list())) return undefined;
        // A job with its answer pending in its live pane was on its question; one picked up keeps where it was parked from.
        return recordPark(c, job, job.parked?.from ?? 'waiting_answer', undefined, why, undefined, { kind: 'busy_machine', how, live });
      });
      if (!parked) continue;
      since.delete(parked.id);
      if (!await finishMove(c, parked)) continue;
      c.trigger('busy_machine.move');
    }
  };
}
