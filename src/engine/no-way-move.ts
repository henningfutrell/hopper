// The no-way move (issue #2355, design.md "Checkpoints and resume elsewhere"): a job picked up to resume elsewhere from its
// checkpoint gets its work from the hopper. On a machine that gives it no way to the hopper — no URL or shell there, a reach
// check that fails, or a pane whose restore finds no `HOPPER_URL` or token file — nothing of the job ran there yet, so it
// goes back to the queue, its session, checkpoint and answer kept, and that machine is held for a while (reach-holds.ts):
// the decider places it on another machine. Before, it ended failed after 3 attempts there. A job moved so
// `MAX_NO_WAY_MOVES` times fails as before (the known cause no-way-to-hopper).
import type { Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

/** The words each of these moves' `job.requeued` reason holds. */
export const NO_WAY_MOVE = 'no way to the hopper there';
/** Why a machine whose job's pane had no way to the hopper is held. */
export const NO_WAY_PANE = 'a job\'s pane there found no HOPPER_URL or no readable token file to restore its checkpoint';
/** How many times one job is moved so before it fails. */
export const MAX_NO_WAY_MOVES = 3;

/**
 * The reason `job` goes back to the queue from machine `machineId`, where it got no way to the hopper (`why`); undefined
 * when it does not: it does not resume elsewhere, or it was moved so `MAX_NO_WAY_MOVES` times already.
 */
export function noWayMove(c: Pick<EngineContext, 'store'>, job: Job, machineId: string, why: string): string | undefined {
  if (!job.parked?.elsewhere) return undefined;
  const moves = c.store.events.recent(100, ['job.requeued'], job.id).filter((e) => String((e.data as { reason?: unknown }).reason).includes(NO_WAY_MOVE));
  return moves.length >= MAX_NO_WAY_MOVES ? undefined : `machine ${machineId}: ${NO_WAY_MOVE}: ${why}`;
}
