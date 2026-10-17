// Restart recovery (design.md "Recovery at startup"). A running job of a non-idempotent executor
// whose external work is still alive is reattached on its lane; one whose work is gone resumes its agent
// session in its kept work tree on its machine (issue #1569, lost-move.ts), or, with none to resume, fails and
// is cleaned up, never re-run; one whose machine does not answer yet stays running on its lane
// while the runner asks again, up to the reconnect grace (issue #368). Claimed jobs (nothing ran) and idempotent jobs return to the queue
// (a pending answer is kept). waiting_answer jobs follow their question. Every other lane closes.
// Several hoppers on one database (issue #1662, design.md "Several hoppers on one database"): a job another live hopper
// holds a lease on is that hopper's, and so is its lane. A job whose lease ended later (its hopper stopped or crashed) is
// taken over the same way (`takeOver`), from the next tick of any hopper on the database.
import type { Job, Question } from '../domain/types.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';
import { recordLostMove } from './lost-move.ts';
import { openItemOf } from './reviews.ts';

export interface Recovered {
  /** Jobs whose external work the caller must clean up, after the commit. */
  toClean: string[];
  /** Running jobs whose executors the caller must reattach, after the commit. */
  reattach: Claim[];
  /** Running jobs whose machine did not answer: the caller reattaches each once it does (Runner.reattachWhenReachable). */
  awaiting: Claim[];
}

/** Why a job is recovered: this hopper started, or the hopper that drove it stopped (issue #1662). */
export type RecoveryReason = 'daemon restart' | 'its hopper stopped';

const RUNNING = ['claimed', 'running'] as const;

/** The running jobs whose executor can reattach them, or cannot tell yet: probed before the transaction (herdr calls). */
async function reattachable(c: EngineContext, jobs: readonly Job[]): Promise<{ reattach: Claim[]; awaiting: Claim[] }> {
  const lanes = c.store.lanes.list();
  const reattach: Claim[] = [];
  const awaiting: Claim[] = [];
  for (const job of jobs) {
    const executor = c.executors.get(job.spec.executor);
    const lane = lanes.find((l) => l.id === job.laneId && l.jobId === job.id);
    if (job.status !== 'running' || !lane || executor?.idempotent !== false || !executor.reattach || !executor.canReattach) continue;
    const claim = { jobId: job.id, laneId: lane.id };
    try {
      if (await executor.canReattach(job)) reattach.push(claim);
    } catch (e) {
      console.warn(`job ${job.id}: machine ${lane.machineId} does not answer yet (${e instanceof Error ? e.message : String(e)}); waiting up to ${c.reconnectGraceMs / 1000} s`);
      awaiting.push(claim);
    }
  }
  return { reattach, awaiting };
}

/**
 * The claimed and running jobs of `jobIds` this hopper takes the lease of, recovered: reattached, moved, requeued or failed.
 * The leases of the jobs not kept running here are released after.
 */
async function recoverJobs(c: EngineContext, jobIds: readonly string[], why: RecoveryReason): Promise<Recovered> {
  const taken = jobIds.filter((id) => c.leases.take(id));
  const unkeep = c.leases.keep(taken);
  try { return await decide(c, taken, why); } finally { unkeep(); }
}

async function decide(c: EngineContext, taken: readonly string[], why: RecoveryReason): Promise<Recovered> {
  const { store } = c;
  const read = store.jobs.getMany(taken);
  const jobs = taken.flatMap((id) => { const j = read.get(id); return j && (RUNNING as readonly string[]).includes(j.status) ? [j] : []; });
  const { reattach, awaiting } = await reattachable(c, jobs);
  const toClean: string[] = [];
  const reattached = new Set([...reattach, ...awaiting].map((r) => r.jobId));
  store.tx(() => {
    for (const r of reattach) store.events.append({ type: 'job.reattached', jobId: r.jobId, laneId: r.laneId, data: { reason: why } });
    for (const { id } of jobs) {
      const job = store.jobs.get(id);
      if (reattached.has(id) || !job || !(RUNNING as readonly string[]).includes(job.status)) continue;
      // A claimed job's executor never started (claim → running happens before it runs): requeue.
      if (job.status === 'running' && c.executors.get(job.spec.executor)?.idempotent === false) {
        // Its machine answered and its work is gone (issue #1569): it resumes its agent session there, when it has one.
        if (!recordLostMove(c, job, job.laneId, 'gone', `its pane was gone after ${why === 'daemon restart' ? 'a daemon restart' : 'its hopper stopped'}`)) {
          failJob(c, job, why === 'daemon restart' ? 'interrupted by daemon restart' : 'interrupted: its hopper stopped');
          toClean.push(job.id);
        }
      }
      else requeue(c, job, job.status, why);
    }
  });
  for (const id of taken) if (!reattached.has(id)) c.leases.release(id);
  return { toClean, reattach, awaiting };
}

function failJob(c: EngineContext, job: Job, error: string): void {
  c.store.jobs.update(job.id, { status: 'failed', error, finishedAt: nowIso(c), laneId: undefined, pendingAnswer: undefined });
  c.store.events.append({ type: 'job.failed', jobId: job.id, data: { error, ...priorityTagOf(c, job.id) } });
}

function requeue(c: EngineContext, job: Job, from: string, reason: string, patch: Partial<Job> = {}): void {
  c.store.jobs.update(job.id, {
    status: 'queued', laneId: undefined, holdReason: undefined, waitReason: undefined, tasks: undefined, progressMessage: undefined, ...patch,
  });
  c.store.events.append({ type: 'job.requeued', jobId: job.id, data: { from, reason } });
}

export async function recover(c: EngineContext): Promise<Recovered> {
  const { store } = c;
  // Another live hopper's jobs, and their lanes, are its own (issue #1662).
  const others = c.leases.heldByOthers();
  const mine = store.jobs.list({ status: [...RUNNING] }).filter((j) => !others.has(j.id));
  const recovered = await recoverJobs(c, mine.map((j) => j.id), 'daemon restart');
  const kept = new Set([...recovered.reattach, ...recovered.awaiting].map((r) => r.laneId));
  const toClean = recovered.toClean;
  const byQuestion = (job: Job, q: Question | undefined): void => {
    if (q?.status === 'open') return; // QuestionService.recover re-drives it
    if (q?.status === 'answered' || q?.status === 'closed') return requeue(c, job, 'waiting_answer', q.status, { pendingAnswer: q.answer ?? '' });
    failJob(c, job, q?.status === 'expired' ? 'question unanswered' : `question ${q?.status ?? 'missing'}`);
    toClean.push(job.id);
  };
  store.tx(() => {
    for (const job of store.jobs.list({ status: ['waiting_answer'] })) {
      // On its proposal or research report (issues #537, #543): it waits on; ReviewService.recover re-drives a review, and
      // a decision ends it or moves it on.
      if (!job.questionId && openItemOf(c, job)) continue;
      byQuestion(job, job.questionId ? store.questions.get(job.questionId) : undefined);
    }
    for (const lane of store.lanes.list()) {
      if (kept.has(lane.id) || (lane.jobId !== undefined && others.has(lane.jobId))) continue;
      store.lanes.close(lane.id);
      store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'daemon restart' } });
    }
  });
  return { toClean, reattach: recovered.reattach, awaiting: recovered.awaiting };
}

/**
 * The claimed and running jobs no live lease holds (issue #1662): the hopper that drove them stopped or crashed, and this
 * one takes them over. Their lanes stay; a lane whose job left it is freed by the next Decision (`freeStrandedLanes`).
 */
export async function takeOver(c: EngineContext, driving: readonly string[]): Promise<Recovered> {
  const ids = c.leases.unheld().filter((id) => !driving.includes(id));
  if (!ids.length) return { toClean: [], reattach: [], awaiting: [] };
  console.warn(`hopper: taking over ${ids.length} job(s) whose hopper stopped: ${ids.join(', ')}`);
  return recoverJobs(c, ids, 'its hopper stopped');
}
