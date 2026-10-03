// Restart recovery (design.md "The engine" and "Recovery at startup (B2, B3)"). Interrupted
// idempotent jobs return to the queue (a pending answer is kept); non-idempotent ones fail and
// are cleaned up, never re-run. waiting_answer jobs follow their question. Every lane closes.
import type { Job, Question } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';

/** Returns the ids of jobs whose external work the caller must clean up, after the commit. */
export function recover(c: EngineContext): string[] {
  const { store } = c;
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
    for (const job of store.jobs.list({ status: ['claimed', 'running'] })) {
      if (c.executors.get(job.spec.executor)?.idempotent === false) fail(job, 'interrupted by daemon restart');
      else requeue(job, job.status, 'daemon restart');
    }
    for (const job of store.jobs.list({ status: ['waiting_answer'] })) {
      byQuestion(job, job.questionId ? store.questions.get(job.questionId) : undefined);
    }
    for (const lane of store.lanes.list()) {
      store.lanes.close(lane.id);
      store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'daemon restart' } });
    }
  });
  return toClean;
}
