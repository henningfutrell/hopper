// The no-way move (issue #2355, design.md "Checkpoints and resume elsewhere"): a job picked up to resume elsewhere from its
// checkpoint gets its work from the hopper. On a machine that gives it no way to the hopper — no URL or shell there, a reach
// check that fails, or a pane whose restore finds no `HOPPER_URL` or token file — nothing of the job ran there yet, so it
// goes back to the queue, its session, checkpoint and answer kept, and that machine is held for a while (reach-holds.ts):
// the decider places it on another machine. Before, it ended failed after 3 attempts there. So does a job that reopens its
// session in a new pane (issue #2427: parked, continued or released): it waits for a machine that reaches the hopper, its
// work kept, and never runs with no way to push it. A job moved so `MAX_NO_WAY_MOVES` times fails as before (the known
// cause no-way-to-hopper).
// A run that ends failed because its session had no way to the hopper (issue #2427: no HOPPER_URL, so it could not push)
// does not fail when it can resume: its checkpoint is taken once more, its last commits in it, and it resumes on another
// machine from it, as the lost-machine move takes a job (`moveNoWay`). Before, its commits stayed on that machine only.
import { matchCause, NO_WAY_TO_HOPPER } from '../failures/causes.ts';
import { reopensPane } from '../domain/checkpoints.ts';
import type { Job, LaneId } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { moveLost } from './lost-move.ts';

/** The words each of these moves' `job.requeued` reason holds. */
export const NO_WAY_MOVE = 'no way to the hopper there';
/** Why a machine whose job's pane had no way to the hopper is held. */
export const NO_WAY_PANE = 'a job\'s pane there found no HOPPER_URL or no readable token file to restore its checkpoint';
/** How many times one job is moved so before it fails. */
export const MAX_NO_WAY_MOVES = 3;

/**
 * The reason `job` goes back to the queue from machine `machineId`, where it got no way to the hopper (`why`); undefined
 * when it does not: it neither resumes elsewhere nor reopens in a new pane, or it was moved so `MAX_NO_WAY_MOVES` times already.
 */
export function noWayMove(c: Pick<EngineContext, 'store'>, job: Job, machineId: string, why: string): string | undefined {
  if (!job.parked?.elsewhere && !reopensPane(job)) return undefined;
  const moves = c.store.events.recent(100, ['job.requeued'], job.id).filter((e) => String((e.data as { reason?: unknown }).reason).includes(NO_WAY_MOVE));
  return moves.length >= MAX_NO_WAY_MOVES ? undefined : `machine ${machineId}: ${NO_WAY_MOVE}: ${why}`;
}

/** The words the park of a run that failed with no way to the hopper holds in its `why`. */
export const NO_WAY_SESSION = 'had no way to the hopper';

/**
 * After a run on `laneId` ended failed with `error`: when the error is the cause no-way-to-hopper,
 * the job resumes on another machine from a checkpoint taken now (issue #2427). False when it does not — another cause, no
 * checkpoint with its agent session, an executor that cannot move it, or `MAX_NO_WAY_MOVES` such moves already —: the
 * caller records the failure, as before.
 */
export async function moveNoWay(c: EngineContext, jobId: string, laneId: LaneId, error: string): Promise<boolean> {
  if (c.stopping() || matchCause(error, '', [])?.id !== NO_WAY_TO_HOPPER) return false;
  const moves = c.store.events.recent(100, ['job.parked'], jobId).filter((e) => String((e.data as { why?: unknown }).why).includes(NO_WAY_SESSION));
  if (moves.length >= MAX_NO_WAY_MOVES) return false;
  // Through the machine's own connection, which the job's session did not need: the commits of its last turn are in it.
  const k = await c.checkpoints?.take(jobId);
  if (k === undefined || typeof k === 'string' || !k.session) {
    if (!c.stopping()) console.warn(`hopper: job ${jobId} had no way to the hopper, and cannot resume elsewhere: its checkpoint ${typeof k === 'string' ? k : k ? 'holds no agent session' : 'is not kept by this hopper'}`);
    return false;
  }
  const machineId = c.store.lanes.list().find((l) => l.id === laneId)?.machineId ?? 'its machine';
  return moveLost(c, jobId, laneId, 'away', `its session on ${machineId} ${NO_WAY_SESSION}: ${error}`);
}
