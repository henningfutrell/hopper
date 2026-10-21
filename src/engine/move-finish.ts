// A move off a machine, finished (issue #1892, milestone 3, design.md "A moved job goes back to the queue"): the
// signed-out and busy-machine moves park a job in one transaction (`recordPark` with its `ParkedMove`), end its pane,
// take its checkpoint once more, and pick it up elsewhere in a later one. A stop between them used to leave the job parked
// for a person and its item in Needs you. The mark on the job says the move is not done: each pass of that move, on the
// host that holds its lease, finishes it first. Each step is safe to do again: a pane whose end was confirmed is not ended
// again, a checkpoint is taken again, and the pick up happens only while the job is still parked for that move.
import type { Job } from '../domain/types.ts';
import type { JobMove } from '../domain/checkpoints.ts';
import type { EngineContext } from './context.ts';
import { recordUnpark } from './park.ts';

/** The pane of the move's job ended: marked, so a later finish does not end a pane its id may name by now. */
function markEnded(c: Pick<EngineContext, 'store'>, job: Job): void {
  c.store.tx(() => {
    const now = c.store.jobs.get(job.id);
    if (now?.status === 'parked' && now.parked?.at === job.parked?.at && now.parked?.move) c.store.jobs.update(job.id, { parked: { ...now.parked, move: { ...now.parked.move, ended: true } } });
  });
}

/**
 * After the park's commit: end the job's pane when it had a live one not ended yet, take its checkpoint once more (its
 * session whole now), and pick it up — from its checkpoint, to resume elsewhere, or queued as a new start. A stop leaves
 * the rest to the next pass. Whether it was picked up.
 */
export async function finishMove(c: EngineContext, parked: Job): Promise<boolean> {
  const { store } = c;
  const move = parked.parked?.move;
  if (!move) return false;
  if (move.live && !move.ended) {
    try {
      await c.executors.get(parked.spec.executor)?.park?.(parked);
      markEnded(c, parked);
    } catch (e) {
      if (!c.stopping()) console.warn(`hopper: job ${parked.id} moves, but its machine could not be reached to end its agent: ${(e as Error).message}; the sweep stops it`);
    }
  }
  // Once more with its live agent ended, so its session is whole; the one before stands if this one fails.
  if (move.live && move.how === 'checkpoint' && !c.stopping()) await c.checkpoints?.take(parked.id);
  if (c.stopping()) return false;
  return store.tx(() => {
    const job = store.jobs.get(parked.id);
    if (job?.status !== 'parked' || job.parked?.at !== parked.parked?.at || job.parked?.move?.kind !== move.kind) return false;
    if (move.how === 'checkpoint') {
      try {
        recordUnpark(c, job.id, false, true);
        return true;
      } catch (e) {
        // A refusal leaves the job parked, and a person picks it up: the move is over.
        const { move: _over, ...rest } = job.parked;
        store.jobs.update(job.id, { parked: rest });
        console.warn(`hopper: job ${job.id} was parked to move, and could not resume elsewhere: ${(e as Error).message}`);
        return false;
      }
    }
    store.jobs.update(job.id, { status: 'queued', parked: undefined, resumeOn: undefined, pendingAnswer: undefined, holdReason: undefined, waitReason: undefined });
    store.events.append({ type: 'job.unparked', jobId: job.id, data: { to: 'queued', elsewhere: true } });
    return true;
  });
}

/** The jobs a stop left parked for move `kind`, finished; whether any was picked up. A pass of that move runs it first. */
export async function finishLeftMoves(c: EngineContext, kind: JobMove): Promise<boolean> {
  let moved = false;
  for (const job of c.store.jobs.list({ status: ['parked'] })) {
    if (c.stopping()) break;
    if (job.parked?.move?.kind === kind && await finishMove(c, job)) moved = true;
  }
  return moved;
}
