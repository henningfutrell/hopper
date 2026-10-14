// Stale questions (issue #529): an open question whose job ended or is gone waits on nothing; the service cancels it,
// at start and on each tick. One a fork of it still works on (issue #548) waits for that: it never expires, and is not
// reminded (issue #570), meanwhile; one that ended without a decision lets it wait on a person again.
import { TERMINAL_STATUSES, type Job, type Question } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';

/** The open questions whose job ended or is gone. */
export function openOnEndedJobs(store: Pick<UserStore, 'questions' | 'jobs'>): Question[] {
  return store.questions.list({ status: ['open'] }).filter((q) => {
    const job = store.jobs.get(q.jobId);
    return !job || TERMINAL_STATUSES.includes(job.status);
  });
}

/** The jobs forked from the question (issue #548), oldest first. */
export function forksOf(store: Pick<UserStore, 'jobs'>, q: Pick<Question, 'id' | 'jobId'>): Job[] {
  return (store.jobs.get(q.jobId)?.forks ?? []).flatMap((id) => {
    const fork = store.jobs.get(id);
    return fork?.forkOf?.questionId === q.id ? [fork] : [];
  });
}

/** A fork that has not ended. */
export const running = (fork: Job): boolean => !TERMINAL_STATUSES.includes(fork.status);

/** A fork of the question still runs (issue #548): the question waits for its result. */
export const forkRuns = (store: Pick<UserStore, 'jobs'>, q: Question): boolean => forksOf(store, q).some(running);

/**
 * The open questions at the human stage (`human`) with no timers armed, whose job is not parked and no fork of which runs:
 * a fork of it ended without a decision (issue #570). They wait on a person again.
 */
export function unarmed(store: Pick<UserStore, 'questions' | 'jobs'>, armed: { has(id: string): boolean }, human: string): Question[] {
  return store.questions.list({ status: ['open'] })
    .filter((q) => q.tier === human && !armed.has(q.id) && store.jobs.get(q.jobId)?.status !== 'parked' && !forkRuns(store, q));
}
