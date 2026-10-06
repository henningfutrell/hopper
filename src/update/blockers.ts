import type { Executor } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

/**
 * How many running jobs a restart would lose: their executor is non-idempotent (never re-run) and cannot
 * reattach. Restart recovery fails such a job (src/engine/recovery.ts), so an update waits for it.
 * A job whose executor is not registered is held at recovery, never lost. A count, never the jobs: the
 * update's status and events are every user's, and a job is its user's own (issue #221).
 */
export function restartBlockers(running: Job[], executorOf: (name: string) => Executor | undefined): number {
  return running.filter((j) => { const e = executorOf(j.spec.executor); return e !== undefined && e.idempotent === false && !e.reattach; }).length;
}
