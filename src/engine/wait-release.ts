// A wait release (issue #2303, design.md "The memory floor"): a job on its own wait kept its agent session live on its
// machine, and on a machine short of memory those sessions alone held enough that the memory floor admitted no new job,
// with nothing running. The Decision names, on each machine a job waits for memory on, every job on its own wait there
// whose wait the hopper ends by itself (`waitSessionsOf`); here each is marked `waitReleased` in the Decision's
// transaction, and after the commit its executor ends its pane and agent on the Park button's path and its checkpoint is
// taken (`releaseParked`). It stays on its wait: what it waits on, its wait check or a person still ends it, and its claim
// then resumes its agent session in a new pane. A wait only its pane carries (its own command, a background poll for
// what the hopper watches nothing of) is never released: ending the pane would end the wait's only watch. A wait with a
// time to wake at (`time_passed`) is the hopper's to end.
import type { Decision, Job, JobId, WaitReleasePlan, WaitSession } from '../domain/types.ts';
import { paneCarriesWait } from '../domain/watched-items.ts';
import type { EngineContext } from './context.ts';
import { releaseParked } from './park.ts';

/** Whether the hopper ends the job's wait by itself, with no pane: what it waits on, or a time it named, is the hopper's to see. */
const hopperEnds = (job: Job): boolean => !job.wait?.ownCommand && (!paneCarriesWait(job) || job.wait?.check?.condition.kind === 'time_passed');

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

/** After the commit: the released job's pane and agent end and its checkpoint is taken, unless its wait ended meanwhile. Never throws. */
export async function releaseWait(c: EngineContext, jobId: JobId): Promise<void> {
  const job = c.store.jobs.get(jobId);
  if (job?.status !== 'waiting_on' || !job.waitReleased) return;
  await releaseParked(c, job);
}
