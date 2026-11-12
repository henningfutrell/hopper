// A wait release (issues #2303, #2326, design.md "Wait release"): a job on its own wait kept its agent session live on its
// machine, and those sessions alone held enough memory that the memory floor admitted no new job, with nothing running.
// The Decision names every job on its own wait whose wait the hopper ends by itself (`waitSessionsOf`), memory short or
// not; here each is marked `waitReleased` in the Decision's transaction, and after the commit its executor ends its pane
// and agent on the Park button's path and its checkpoint is taken (`releaseWait`). It stays on its wait: what it waits on,
// its wait check or a person still ends it. With that checkpoint kept (`waitReleased.checkpointAt`), its wake queues it to
// resume on any machine with room (src/engine/wait.ts); else its claim resumes its agent session in a new pane on its own
// machine. Every wait is released but one on its own command: a build or a test run of the job runs in its pane, and ending
// the pane would end it. An outside event the hopper watches nothing of (once a background poll in the pane) is released too:
// a person ends it, or the check-in the job named rechecks it (issues #2335, #2338).
import type { ActingPerson, Decision, Job, JobId, WaitReleasePlan, WaitSession } from '../domain/types.ts';
import { conditionOf } from '../domain/wait-checks.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { resumesElsewhere } from './wait.ts';

/** Whether the hopper ends the job's wait by itself, with no pane: every wait but one on its own command (issue #2335). */
const hopperEnds = (job: Job): boolean => conditionOf(job).kind !== 'command_exited';

/** The jobs on their own wait whose agent may end to free memory: live, with a session to resume, an executor that parks, and a machine. */
export function waitSessionsOf(c: Pick<EngineContext, 'store'>, parking: readonly string[]): WaitSession[] {
  return c.store.jobs.list({ status: ['waiting_on'] }).flatMap((j) => (
    j.wait && !j.waitReleased && !j.wait.strandedAt && j.agentSession !== undefined && j.resumeOn !== undefined && parking.includes(j.spec.executor) && hopperEnds(j)
      ? [{ jobId: j.id, machineId: j.resumeOn, since: j.wait.since }]
      : []));
}

/** In the Decision's tx: each job named still on its wait is marked, with `job.wait_released`. The jobs whose agents end after the commit. */
export function recordWaitReleases(c: Pick<EngineContext, 'store'>, d: Pick<Decision, 'id' | 'at'>, plans: readonly WaitReleasePlan[]): JobId[] {
  const { store } = c;
  const released: JobId[] = [];
  for (const p of plans) {
    const job = store.jobs.get(p.jobId);
    if (job?.status !== 'waiting_on' || job.waitReleased) continue;
    store.jobs.update(p.jobId, { waitReleased: { at: d.at, machineId: p.machineId } });
    store.events.append({ type: 'job.wait_released', jobId: p.jobId, machineId: p.machineId, decisionId: d.id, data: { reason: p.reason } });
    released.push(p.jobId);
  }
  return released;
}

/**
 * After the commit: the released job's pane and agent end, then its checkpoint is taken, its agent session whole now, unless
 * its wait ended meanwhile. A checkpoint with the session is marked on the job (`waitReleased.checkpointAt`): its wake may
 * resume it on any machine (issue #2326). Never throws; what it cannot reach, the sweep stops.
 */
export async function releaseWait(c: EngineContext, jobId: JobId): Promise<string | undefined> {
  const job = c.store.jobs.get(jobId);
  if (job?.status !== 'waiting_on' || !job.waitReleased) return 'it is no longer on its wait';
  try {
    await c.executors.get(job.spec.executor)?.park?.(job);
  } catch (e) {
    if (!c.stopping()) console.warn(`hopper: job ${job.id} released on its wait, but its machine could not be reached to end its agent: ${(e as Error).message}; the sweep stops it`);
    return `its machine could not be reached to end its agent: ${(e as Error).message}`;
  }
  if (!c.checkpoints) return 'this hopper keeps no checkpoints';
  if (c.stopping()) return 'the hopper stops';
  const k = await c.checkpoints.take(jobId);
  if (typeof k === 'string') return `its checkpoint was not taken: ${k}`;
  if (!k.session) return 'its checkpoint holds no agent session';
  if (c.stopping()) return 'the hopper stops';
  c.store.tx(() => {
    const now = c.store.jobs.get(jobId);
    if (now?.status === 'waiting_on' && now.waitReleased) c.store.jobs.update(jobId, { waitReleased: { ...now.waitReleased, checkpointAt: k.at } });
  });
  return undefined;
}

/** Why a person cannot release the wait of `job` to free its machine (issue #2932); undefined: they can. */
export function personReleaseRefusal(c: Pick<EngineContext, 'executors'>, job: Job): string | undefined {
  if (job.status !== 'waiting_on') return `job ${job.id} is ${job.status}: only a job on its own wait has its wait released`;
  if (!hopperEnds(job)) return `job ${job.id} waits on its own command, which runs in its pane: wait for it to end, or cancel the job`;
  if (job.resumeOn === undefined) return `job ${job.id} waits on no machine: nothing to release`;
  if (job.agentSession === undefined) return `job ${job.id} has no agent session to resume: cancel it and run it again`;
  if (job.spec.machineId !== undefined) return `job ${job.id} is pinned to ${job.spec.machineId}: cancel it and run it again`;
  if (!c.executors.get(job.spec.executor)?.park) return `job ${job.id}'s executor ${job.spec.executor} cannot end its agent: cancel it and run it again`;
  return undefined;
}

/**
 * A person's release of a job's own wait (issue #2932, design.md "Removing a machine"): as the Decision's release, its agent
 * ends and its checkpoint is taken now, so it no longer holds its machine; woken, it resumes on any machine with room. A
 * wait released already whose checkpoint was not kept is tried again. Not found, or a conflict that says why: not on its own
 * wait, on its own command, pinned, with no session, or its checkpoint not kept.
 */
export async function releaseWaitByPerson(c: EngineContext, jobId: JobId, acting: ActingPerson): Promise<Job> {
  const job = c.store.tx(() => {
    const now = c.store.jobs.get(jobId);
    if (!now) throw new EngineError('not_found', `job ${jobId} not found`);
    const refused = personReleaseRefusal(c, now);
    if (refused) throw new EngineError('conflict', refused);
    if (resumesElsewhere(now) || now.waitReleased) return now;
    const machineId = now.resumeOn!;
    const released = c.store.jobs.update(jobId, { waitReleased: { at: nowIso(c), machineId } });
    const reason = `${acting.person} released the agent of ${jobId} on ${machineId}: it resumes its session on any machine with room when its wait ends`;
    c.store.events.append({ type: 'job.wait_released', jobId, machineId, data: { reason, by: acting.person, via: acting.via } });
    return released;
  });
  if (resumesElsewhere(job)) return job;
  const why = await releaseWait(c, jobId);
  const after = c.store.jobs.get(jobId);
  if (!after) throw new EngineError('not_found', `job ${jobId} not found`);
  if (after.status === 'waiting_on' && !resumesElsewhere(after)) {
    throw new EngineError('conflict', `job ${jobId} still needs its machine: ${why ?? 'its checkpoint was not kept'}. Try again, or cancel it and run it again`);
  }
  return after;
}
