// Stale questions (issue #529): an open question whose job ended or is gone waits on nothing; the service cancels it,
// at start and on each tick. One a fork of it still works on (issue #548) waits for that, and never expires meanwhile.
import { TERMINAL_STATUSES, type Question } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';

/** The open questions whose job ended or is gone. */
export function openOnEndedJobs(store: Pick<UserStore, 'questions' | 'jobs'>): Question[] {
  return store.questions.list({ status: ['open'] }).filter((q) => {
    const job = store.jobs.get(q.jobId);
    return !job || TERMINAL_STATUSES.includes(job.status);
  });
}

/** A fork of the question still runs (issue #548): the question waits for its result. */
export function forkRuns(store: Pick<UserStore, 'jobs'>, q: Question): boolean {
  return (store.jobs.get(q.jobId)?.forks ?? []).some((id) => {
    const fork = store.jobs.get(id);
    return fork?.forkOf?.questionId === q.id && !TERMINAL_STATUSES.includes(fork.status);
  });
}
