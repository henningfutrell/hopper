// Parking a job (issue #501, design.md "Parked jobs"): a person takes a running job, or one on a question, out of
// its lane for an open-ended time. The lane frees in the transaction that parks it; the executor then ends its pane
// and agent and stops its processes, keeping its work tree and agent session. Re-queued, it waits pinned to its
// machine (`resumeOn`) with an answer pending — the one given while it was parked, else PARKED_RESUME — so its claim
// resumes the agent session there; with its question still open, it waits on the question again.
import type { Job, LaneId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { releaseLane } from './outcome.ts';

/** What the resumed agent session is told when no answer waits for it: it was parked, and goes on. */
export const PARKED_RESUME = 'This job was parked and is resumed now, in the same session and work tree. Go on with it where you left off.';

const PARKABLE = new Set<Job['status']>(['running', 'waiting_answer']);

/** Why the job cannot be parked, or undefined: running or on a question, with an agent session its executor can resume. */
export function parkRefusal(c: Pick<EngineContext, 'executors'>, job: Job): string | undefined {
  if (!PARKABLE.has(job.status)) return `job ${job.id} is ${job.status}: only a running job or one on a question can be parked`;
  if (!c.executors.get(job.spec.executor)?.park) return `job ${job.id}: executor ${job.spec.executor} cannot park a job`;
  if (job.agentSession === undefined) return `job ${job.id} has no agent session to resume: its executor recorded none`;
  return undefined;
}

/** Inside a tx: the job parked from `from`, its lane (if any) freed. Its question, if open, stays open. */
export function recordPark(c: EngineContext, job: Job, from: 'running' | 'waiting_answer', laneId?: LaneId): Job {
  const { store } = c;
  const at = nowIso(c);
  const lane = laneId ? store.lanes.list().find((l) => l.id === laneId) : undefined;
  const machineId = lane?.machineId ?? job.resumeOn ?? job.spec.machineId;
  const parked = store.jobs.update(job.id, {
    status: 'parked', laneId: undefined, parked: { at, from }, ...(machineId ? { resumeOn: machineId } : {}),
    holdReason: undefined, waitReason: undefined,
  });
  store.events.append({ type: 'job.parked', jobId: job.id, ...(laneId ? { laneId } : {}), data: { from, ...(machineId ? { machineId } : {}) } });
  releaseLane(c, lane, at);
  return parked;
}

/** After the commit: the executor ends the job's pane and agent. Never throws; what it cannot reach, the sweep stops. */
export async function releaseParked(c: Pick<EngineContext, 'executors' | 'stopping'>, job: Job): Promise<void> {
  try {
    await c.executors.get(job.spec.executor)?.park?.(job);
  } catch (e) {
    if (!c.stopping()) console.warn(`hopper: job ${job.id} parked, but its machine could not be reached to end its agent: ${(e as Error).message}; the sweep stops it`);
  }
}

/**
 * Re-queue a parked job: back to the queue pinned to its machine, an answer pending; or, with its question still
 * open, back to waiting on it (the caller re-arms the question after the commit).
 */
export function recordUnpark(c: EngineContext, id: string): Job {
  const { store } = c;
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (job.status !== 'parked') throw new EngineError('conflict', `job ${id} is ${job.status}: only a parked job can be re-queued`);
  const q = job.questionId ? store.questions.get(job.questionId) : undefined;
  if (q?.status === 'open' && job.pendingAnswer === undefined) {
    const next = store.jobs.update(id, { status: 'waiting_answer' });
    store.events.append({ type: 'job.unparked', jobId: id, questionId: q.id, data: { to: 'waiting_answer' } });
    return next;
  }
  const next = store.jobs.update(id, { status: 'queued', pendingAnswer: job.pendingAnswer ?? PARKED_RESUME, holdReason: undefined, waitReason: undefined });
  store.events.append({ type: 'job.unparked', jobId: id, data: { to: 'queued' } });
  return next;
}
