// The engine's side of the answer chain. QuestionService calls these synchronously INSIDE
// the transaction that settles the question (design.md "Atomicity (B3)"), so question and job
// change together. Both are compare-and-set: they act only on a job still waiting on that
// question, and are a logged no-op otherwise.
import type { Question } from '../domain/types.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { forksOnAnswered } from './phase-shifts.ts';

export interface AnswerHandlers {
  /** Requeue the job with the answer (or, for a closed question, the close text) pending; the next claim resumes it. */
  onAnswered(q: Question): void;
  /** Fail the job; its pane is cleaned up after the commit. */
  onExpired(q: Question): void;
  /** Cancel the job if it still waits on the question, parked or not (a job that moved on is left alone); its pane, or its parked work, is cleaned up after the commit. */
  onDismissed(q: Question): void;
}

export function createAnswerHandlers(c: EngineContext, cleanup: Cleanup): AnswerHandlers {
  const { store } = c;
  const waitingOn = (q: Question): boolean => {
    const job = store.jobs.get(q.jobId);
    if (job?.status === 'waiting_answer' && job.questionId === q.id) return true;
    console.error(`question ${q.id}: job ${q.jobId} is ${job?.status ?? 'missing'} (question ${job?.questionId ?? 'none'}); ignored`);
    return false;
  };
  /** A parked job (issue #501) keeps the answer to its question until it is re-queued; it stays parked. */
  const parkedOn = (q: Question): boolean => {
    const job = store.jobs.get(q.jobId);
    return job?.status === 'parked' && job.questionId === q.id;
  };
  return {
    onAnswered(q) {
      // Forks of it still running (issue #570): they keep the answer, and the job is told they run.
      const forks = forksOnAnswered(c, q);
      const answer = forks ? `${q.answer ?? ''}\n\n${forks}` : q.answer ?? '';
      if (parkedOn(q)) {
        store.jobs.update(q.jobId, { pendingAnswer: answer });
        return;
      }
      if (!waitingOn(q)) return;
      store.jobs.update(q.jobId, { status: 'queued', pendingAnswer: answer, holdReason: undefined, waitReason: undefined });
      store.events.append({ type: 'job.requeued', jobId: q.jobId, questionId: q.id, data: { from: 'waiting_answer', reason: q.status === 'closed' ? 'closed' : 'answered' } });
    },
    onExpired(q) {
      if (!waitingOn(q)) return;
      const error = 'question unanswered';
      store.jobs.update(q.jobId, { status: 'failed', error, finishedAt: nowIso(c) });
      store.events.append({ type: 'job.failed', jobId: q.jobId, questionId: q.id, data: { error, ...priorityTagOf(c, q.jobId) } });
      // After the surrounding tx commits.
      setImmediate(() => void cleanup(q.jobId));
    },
    onDismissed(q) {
      const job = store.jobs.get(q.jobId);
      if ((job?.status !== 'waiting_answer' && job?.status !== 'parked') || job.questionId !== q.id) return;
      store.jobs.update(q.jobId, { status: 'cancelled', finishedAt: nowIso(c), pendingAnswer: undefined });
      store.events.append({ type: 'job.cancelled', jobId: q.jobId, questionId: q.id, data: { reason: 'question dismissed' } });
      setImmediate(() => void cleanup(q.jobId));
    },
  };
}
