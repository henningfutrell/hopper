// The lost-machine move (issue #1569, design.md "The lost-machine move"): a running job whose machine is lost resumes, and
// does not fail, when it has an agent session to resume. Its machine answers but its work is gone (`gone`: the pane or agent
// went with a restart): it resumes that session in its kept work tree, on the same machine. Its machine stays away past the
// grace (`away`: after a restart, or a link that dropped): it resumes on another machine from its last checkpoint, and a
// `job-move` saga, keyed by the job and its attempt, ends the agent it left there once that machine answers. Both are a park
// and a pick up, as the signed-out move makes them. A job with nothing to resume from fails as before.
import type { Job, LaneId } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { recordPark, recordUnpark } from './park.ts';

/** `gone`: its machine answers, its work does not. `away`: its machine did not answer within the grace. */
export type Lost = 'gone' | 'away';

/** The saga kind that ends the agent a moved job left on its lost machine. */
export const JOB_MOVE_SAGA = 'job-move';

/** What the `job-move` saga gets: the job, the machine it left, and its executor state there (the pane to end). */
export interface JobMoveData { jobId: string; machineId: string; left: Job['executorState'] }

/** The `job-move` saga's key: one per job and attempt, so a second move of the same run begins no second saga. */
export const jobMoveKey = (job: Pick<Job, 'id' | 'attempts'>): string => `${job.id}/${job.attempts}`;

/** What the resumed agent is told: why its run was cut off, and to go on. */
export const lostResumeText = (why: string): string =>
  `This job's run was cut off: ${why}. It resumes now in the same agent session. Look at git status and git diff first, then go on where you left off.`;

/** How the job resumes after its machine was lost — on it (`here`) or on another (`elsewhere`) —, or why it cannot. */
export function lostResume(c: Pick<EngineContext, 'executors' | 'jobMoves'>, job: Job, lost: Lost, machineId: string | undefined): 'here' | 'elsewhere' | { refused: string } {
  const executor = c.executors.get(job.spec.executor);
  if (!executor?.park) return { refused: `its executor ${job.spec.executor} cannot resume it` };
  if (!job.agentSession) return { refused: 'it has no agent session to resume' };
  if (lost === 'gone') return machineId ? 'here' : { refused: 'its machine is not known' };
  if (!executor.endLeft || !executor.leftOf || !c.jobMoves) return { refused: `its executor ${job.spec.executor} cannot end what it left on its machine` };
  if (!job.checkpoint?.session) return { refused: 'it has no checkpoint with its agent session to resume elsewhere from' };
  return 'elsewhere';
}

const machineOf = (c: Pick<EngineContext, 'store'>, laneId: LaneId | undefined): string | undefined =>
  laneId ? c.store.lanes.list().find((l) => l.id === laneId)?.machineId : undefined;

/**
 * Inside a tx: the running job on `laneId` resumes after its machine was lost, `why`: parked, its lane freed, and picked up
 * again, pinned to its machine (`gone`) or to resume elsewhere (`away`). False when it cannot resume (the caller fails it).
 * The `job-move` saga of an `away` move is begun by `moveLost` before this.
 */
export function recordLostMove(c: EngineContext, job: Job, laneId: LaneId | undefined, lost: Lost, why: string): boolean {
  const how = lostResume(c, job, lost, machineOf(c, laneId));
  if (typeof how !== 'string') return false;
  // Named as a move (issue #1892): its item stays in the queue; its pick up below, in the same tx, ends the move.
  recordPark(c, job, 'running', laneId, why, undefined, { kind: 'lost_machine', how: 'checkpoint', live: false });
  // Moved away: a new proxy token for its next run, so the agent left on the lost machine is refused from now on.
  c.store.jobs.update(job.id, { pendingAnswer: lostResumeText(why), ...(how === 'elsewhere' ? { movedAway: (job.movedAway ?? 0) + 1 } : {}) });
  const next = recordUnpark(c, job.id, false, how === 'elsewhere');
  // Not back to the machine it left while its agent there may run: the `job-move` saga lifts the mark (`liftLost`).
  if (next.parked?.elsewhere) c.store.jobs.update(job.id, { parked: { ...next.parked, elsewhere: { ...next.parked.elsewhere, lost: true } } });
  return true;
}

/** The agent a moved job left on its lost machine is ended (issue #1569): the job may be placed on that machine again. */
export function liftLost(c: Pick<EngineContext, 'store' | 'trigger'>, jobId: string): void {
  const job = c.store.jobs.get(jobId);
  const parked = job?.parked;
  if (!parked?.elsewhere?.lost) return;
  const { lost: _lifted, ...elsewhere } = parked.elsewhere;
  c.store.jobs.update(jobId, { parked: { ...parked, elsewhere } });
  c.trigger('lost.lifted');
}

/**
 * After a run's outcome: the running job resumes after its machine was lost, `why`; false when it cannot (the caller
 * records the failure). An `away` move begins its `job-move` saga first: begun twice, or for a move that did not happen,
 * the saga finds the job's pane its own and ends nothing.
 */
export function moveLost(c: EngineContext, jobId: string, laneId: LaneId, lost: Lost, why: string): boolean {
  const job = c.store.jobs.get(jobId);
  if (!job || c.stopping()) return false;
  const machineId = machineOf(c, laneId);
  const how = lostResume(c, job, lost, machineId);
  if (typeof how !== 'string') {
    console.warn(`hopper: job ${jobId} lost its machine (${why}) and cannot resume: ${how.refused}`);
    return false;
  }
  if (how === 'elsewhere') {
    const data: JobMoveData = { jobId, machineId: machineId ?? job.resumeOn ?? 'unknown', left: c.executors.get(job.spec.executor)?.leftOf?.(job) };
    c.jobMoves?.begin(jobMoveKey(job), data);
  }
  const moved = c.store.tx(() => {
    const now = c.store.jobs.get(jobId);
    return now?.status === 'running' && now.laneId === laneId && recordLostMove(c, now, laneId, lost, why);
  });
  if (moved) {
    console.warn(`hopper: job ${jobId} lost its machine (${why}): it resumes ${how === 'here' ? `on ${machineId}` : 'on another machine from its checkpoint'}`);
    c.trigger('lost.move');
  }
  return moved;
}
