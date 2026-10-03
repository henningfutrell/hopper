// The engine's side of the answer chain. QuestionService calls these synchronously INSIDE
// the transaction that settles the question (design.md "Atomicity (B3)"), so question and job
// change together. Both are compare-and-set: they act only on a job still waiting on that
// question, and are a logged no-op otherwise.
import type { Question } from '../domain/types.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, type EngineContext } from './context.ts';

export interface AnswerHandlers {
  /** Requeue the job with the answer pending; the next claim resumes it. */
  onAnswered(q: Question): void;
  /** Fail the job; its pane is cleaned up after the commit. */
  onExpired(q: Question): void;
}

export function createAnswerHandlers(c: EngineContext, cleanup: Cleanup): AnswerHandlers {
  const { store } = c;
  const waitingOn = (q: Question): boolean => {
    const job = store.jobs.get(q.jobId);
    if (job?.status === 'waiting_answer' && job.questionId === q.id) return true;
    console.error(`question ${q.id}: job ${q.jobId} is ${job?.status ?? 'missing'} (question ${job?.questionId ?? 'none'}); ignored`);
    return false;
  };
  return {
    onAnswered(q) {
      if (!waitingOn(q)) return;
      store.jobs.update(q.jobId, { status: 'queued', pendingAnswer: q.answer ?? '', holdReason: undefined });
      store.events.append({ type: 'job.requeued', jobId: q.jobId, questionId: q.id, data: { from: 'waiting_answer', reason: 'answered' } });
    },
    onExpired(q) {
      if (!waitingOn(q)) return;
      const error = 'question unanswered';
      store.jobs.update(q.jobId, { status: 'failed', error, finishedAt: nowIso(c) });
      store.events.append({ type: 'job.failed', jobId: q.jobId, questionId: q.id, data: { error } });
      // After the surrounding tx commits.
      setImmediate(() => void cleanup(q.jobId));
    },
  };
}
