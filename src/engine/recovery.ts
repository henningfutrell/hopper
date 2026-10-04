// Restart recovery (design.md "Recovery at startup"). A running job of a non-idempotent executor
// whose external work is still alive is reattached on its lane; one whose work is gone fails and
// is cleaned up, never re-run. Claimed jobs (nothing ran) and idempotent jobs return to the queue
// (a pending answer is kept). waiting_answer jobs follow their question. Every other lane closes.
import type { Job, Question } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';

export interface Recovered {
  /** Jobs whose external work the caller must clean up, after the commit. */
  toClean: string[];
  /** Running jobs whose executors the caller must reattach, after the commit. */
  reattach: Claim[];
}

/** The running jobs whose executor can reattach them: probed before the transaction (herdr calls). */
async function reattachable(c: EngineContext): Promise<Claim[]> {
  const lanes = c.store.lanes.list();
  const claims: Claim[] = [];
  for (const job of c.store.jobs.list({ status: ['running'] })) {
    const executor = c.executors.get(job.spec.executor);
    const lane = lanes.find((l) => l.id === job.laneId && l.jobId === job.id);
    if (!lane || executor?.idempotent !== false || !executor.reattach) continue;
    if (await executor.canReattach?.(job).catch(() => false)) claims.push({ jobId: job.id, laneId: lane.id });
  }
  return claims;
}

export async function recover(c: EngineContext): Promise<Recovered> {
  const { store } = c;
  const reattach = await reattachable(c);
  const kept = new Set(reattach.map((r) => r.laneId));
  const toClean: string[] = [];
  const fail = (job: Job, error: string): void => {
    store.jobs.update(job.id, { status: 'failed', error, finishedAt: nowIso(c), laneId: undefined, pendingAnswer: undefined });
    store.events.append({ type: 'job.failed', jobId: job.id, data: { error } });
    toClean.push(job.id);
  };
  const requeue = (job: Job, from: string, reason: string, patch: Partial<Job> = {}): void => {
    store.jobs.update(job.id, {
      status: 'queued', laneId: undefined, holdReason: undefined, progress: undefined, progressMessage: undefined, ...patch,
    });
    store.events.append({ type: 'job.requeued', jobId: job.id, data: { from, reason } });
  };
  const byQuestion = (job: Job, q: Question | undefined): void => {
    if (q?.status === 'open') return; // QuestionService.recover re-drives it
    if (q?.status === 'answered') return requeue(job, 'waiting_answer', 'answered', { pendingAnswer: q.answer ?? '' });
    fail(job, q?.status === 'expired' ? 'question unanswered' : `question ${q?.status ?? 'missing'}`);
  };
  store.tx(() => {
    for (const r of reattach) {
      store.events.append({ type: 'job.reattached', jobId: r.jobId, laneId: r.laneId, data: { reason: 'daemon restart' } });
    }
    const reattached = new Set(reattach.map((r) => r.jobId));
    for (const job of store.jobs.list({ status: ['claimed', 'running'] })) {
      if (reattached.has(job.id)) continue;
      // A claimed job's executor never started (claim → running happens before it runs): requeue.
      if (job.status === 'running' && c.executors.get(job.spec.executor)?.idempotent === false) fail(job, 'interrupted by daemon restart');
      else requeue(job, job.status, 'daemon restart');
    }
    for (const job of store.jobs.list({ status: ['waiting_answer'] })) {
      byQuestion(job, job.questionId ? store.questions.get(job.questionId) : undefined);
    }
    for (const lane of store.lanes.list()) {
      if (kept.has(lane.id)) continue;
      store.lanes.close(lane.id);
      store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'daemon restart' } });
    }
  });
  return { toClean, reattach };
}
