// Stale questions (issue #529): an open question whose job ended or is gone waits on nothing; the service cancels it,
// at start and on each tick.
import { TERMINAL_STATUSES, type Question } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';

/** The open questions whose job ended or is gone. */
export function openOnEndedJobs(store: Pick<UserStore, 'questions' | 'jobs'>): Question[] {
  return store.questions.list({ status: ['open'] }).filter((q) => {
    const job = store.jobs.get(q.jobId);
    return !job || TERMINAL_STATUSES.includes(job.status);
  });
}
