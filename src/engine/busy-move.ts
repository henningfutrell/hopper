// The busy-machine move (issue #1977, design.md "The busy-machine move"): on each tick, a job queued to resume on its own
// machine, where every lane is in use, waits there `RESUME_WAIT_MS` at most while another machine that runs its executor has
// room (`busyMove`, src/decider/busy-move.ts). Then it goes on there, with no person, as the signed-out move takes a job: from
// its checkpoint, picked up to resume elsewhere (`recordUnpark`, elsewhere), or, when its agent never got its task, queued as
// a new start, not pinned. The hopper parks it first (`recordPark`, auto, with why), so nothing claims it meanwhile; a job
// whose answer waits in its live pane gets its pane and agent ended (`Executor.park`) and one more checkpoint. A job the move
// cannot checkpoint, or whose checkpoint holds work but no agent session, stays on its machine and is tried again after a while.
import { busyMove } from '../decider/busy-move.ts';
import type { Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { recordPark, recordUnpark } from './park.ts';
import { howToMove, MOVE_RETRY_MS } from './signed-out-move.ts';

/** How long a resuming job waits for a lane on its own full machine while another machine has room. */
export const RESUME_WAIT_MS = 5 * 60_000;

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
    const queued = store.jobs.list({ status: ['queued'] });
    const seen = new Set(queued.map((j) => j.id));
    for (const id of since.keys()) if (!seen.has(id)) since.delete(id);
    const machines = await c.machines.list();
    for (const waiting of queued) {
      if (c.stopping()) return;
      const to = busyMove(waiting, machines, store.lanes.list());
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
        return recordPark(c, job, job.parked?.from ?? 'waiting_answer', undefined, why);
      });
      if (!parked) continue;
      since.delete(parked.id);
      if (live) {
        try {
          await c.executors.get(parked.spec.executor)?.park?.(parked);
        } catch (e) {
          if (!c.stopping()) console.warn(`hopper: job ${parked.id} moves, but its machine could not be reached to end its agent: ${(e as Error).message}; the sweep stops it`);
        }
        // Once more with its agent ended, so its session is whole; the one before stands if this one fails.
        if (how === 'checkpoint' && !c.stopping()) await c.checkpoints?.take(parked.id);
      }
      if (c.stopping()) return;
      store.tx(() => {
        const job = store.jobs.get(parked.id);
        if (job?.status !== 'parked') return;
        if (how === 'checkpoint') {
          // A refusal writes nothing: the job stays parked, and a person picks it up.
          try {
            recordUnpark(c, job.id, false, true);
          } catch (e) {
            console.warn(`hopper: job ${job.id} was parked to move, and could not resume elsewhere: ${(e as Error).message}`);
          }
          return;
        }
        store.jobs.update(job.id, { status: 'queued', parked: undefined, resumeOn: undefined, pendingAnswer: undefined, holdReason: undefined, waitReason: undefined });
        store.events.append({ type: 'job.unparked', jobId: job.id, data: { to: 'queued', elsewhere: true } });
      });
      c.trigger('busy_machine.move');
    }
  };
}
