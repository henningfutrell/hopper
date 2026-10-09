// Restart recovery (design.md "Recovery at startup"). A running job of a non-idempotent executor
// whose external work is still alive is reattached on its lane; one whose work is gone fails and
// is cleaned up, never re-run; one whose machine does not answer yet stays running on its lane
// while the runner asks again, up to the reconnect grace (issue #368). Claimed jobs (nothing ran) and idempotent jobs return to the queue
// (a pending answer is kept). waiting_answer jobs follow their question. Every other lane closes.
import type { Job, Question } from '../domain/types.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';
import { openItemOf } from './reviews.ts';

export interface Recovered {
  /** Jobs whose external work the caller must clean up, after the commit. */
  toClean: string[];
  /** Running jobs whose executors the caller must reattach, after the commit. */
  reattach: Claim[];
  /** Running jobs whose machine did not answer: the caller reattaches each once it does (Runner.reattachWhenReachable). */
  awaiting: Claim[];
}

/** The running jobs whose executor can reattach them, or cannot tell yet: probed before the transaction (herdr calls). */
async function reattachable(c: EngineContext): Promise<{ reattach: Claim[]; awaiting: Claim[] }> {
  const lanes = c.store.lanes.list();
  const reattach: Claim[] = [];
  const awaiting: Claim[] = [];
  for (const job of c.store.jobs.list({ status: ['running'] })) {
    const executor = c.executors.get(job.spec.executor);
    const lane = lanes.find((l) => l.id === job.laneId && l.jobId === job.id);
    if (!lane || executor?.idempotent !== false || !executor.reattach || !executor.canReattach) continue;
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

export async function recover(c: EngineContext): Promise<Recovered> {
  const { store } = c;
  const { reattach, awaiting } = await reattachable(c);
  const kept = new Set([...reattach, ...awaiting].map((r) => r.laneId));
  const toClean: string[] = [];
  const fail = (job: Job, error: string): void => {
    store.jobs.update(job.id, { status: 'failed', error, finishedAt: nowIso(c), laneId: undefined, pendingAnswer: undefined });
    store.events.append({ type: 'job.failed', jobId: job.id, data: { error, ...priorityTagOf(c, job.id) } });
    toClean.push(job.id);
  };
  const requeue = (job: Job, from: string, reason: string, patch: Partial<Job> = {}): void => {
    store.jobs.update(job.id, {
      status: 'queued', laneId: undefined, holdReason: undefined, waitReason: undefined, progress: undefined, progressMessage: undefined, ...patch,
    });
    store.events.append({ type: 'job.requeued', jobId: job.id, data: { from, reason } });
  };
  const byQuestion = (job: Job, q: Question | undefined): void => {
    if (q?.status === 'open') return; // QuestionService.recover re-drives it
    if (q?.status === 'answered' || q?.status === 'closed') return requeue(job, 'waiting_answer', q.status, { pendingAnswer: q.answer ?? '' });
    fail(job, q?.status === 'expired' ? 'question unanswered' : `question ${q?.status ?? 'missing'}`);
  };
  store.tx(() => {
    for (const r of reattach) {
      store.events.append({ type: 'job.reattached', jobId: r.jobId, laneId: r.laneId, data: { reason: 'daemon restart' } });
    }
    const reattached = new Set([...reattach, ...awaiting].map((r) => r.jobId));
    for (const job of store.jobs.list({ status: ['claimed', 'running'] })) {
      if (reattached.has(job.id)) continue;
      // A claimed job's executor never started (claim → running happens before it runs): requeue.
      if (job.status === 'running' && c.executors.get(job.spec.executor)?.idempotent === false) fail(job, 'interrupted by daemon restart');
      else requeue(job, job.status, 'daemon restart');
    }
    for (const job of store.jobs.list({ status: ['waiting_answer'] })) {
      // On its proposal or research report (issues #537, #543): it waits on; ReviewService.recover re-drives a review, and
      // a decision ends it or moves it on.
      if (!job.questionId && openItemOf(c, job)) continue;
      byQuestion(job, job.questionId ? store.questions.get(job.questionId) : undefined);
    }
    for (const lane of store.lanes.list()) {
      if (kept.has(lane.id)) continue;
      store.lanes.close(lane.id);
      store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'daemon restart' } });
    }
  });
  return { toClean, reattach, awaiting };
}
