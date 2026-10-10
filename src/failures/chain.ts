// A failed job's chain of runs (issues #509, #630), as the failure assessor reads it from the store: its run in the
// chain of retries, and — a timed-out job's — its liveness and the timed-out runs just before it.
import type { UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import type { LivenessFacts, TimeoutKind } from './timed-out.ts';

type Reads = Pick<UserStore, 'jobs' | 'failures'>;

/** Its run in its chain of retries: 1, plus each earlier job of its item that a retry ran again. */
export function attemptOf(store: Reads, job: Job): number {
  let n = 1;
  for (let prev = job.rerunOf; prev !== undefined; prev = store.jobs.get(prev)?.rerunOf) {
    if (store.failures.forJob(prev)?.outcome !== 'retried') break;
    n += 1;
  }
  return n;
}

/**
 * The timed-out runs of its chain just before this one, newest first (issue #630): each one the assessor ran again for
 * its timeout — continued (active) or retried (silent) —, back to the first run of the chain that was not. A continued
 * run is the same job: its earlier records count as well as its earlier jobs'.
 */
export function earlierTimeoutsOf(store: Reads, job: Job): TimeoutKind[] {
  const out: TimeoutKind[] = [];
  for (let cur: Job | undefined = job; cur; cur = cur.rerunOf ? store.jobs.get(cur.rerunOf) : undefined) {
    for (const r of store.failures.list({ jobId: cur.id })) {
      const kind = r.causeId === 'timed-out' && r.outcome === 'retried' ? ({ continue: 'active', retry: 'silent' } as const)[r.decision as 'continue' | 'retry'] : undefined;
      if (!kind) return out;
      out.push(kind);
    }
  }
  return out;
}

/** A timed-out job's liveness as the rules read it (issue #630): its output's age at its timeout. */
export function livenessOf(job: Job): LivenessFacts | undefined {
  const l = job.liveness;
  if (!l) return undefined;
  const timedOutAt = Date.parse(job.finishedAt ?? job.updatedAt);
  return {
    ...(l.outputAt !== undefined ? { outputAgoMs: Math.max(0, timedOutAt - Date.parse(l.outputAt)) } : {}),
    ...(l.pushed !== undefined ? { pushed: l.pushed } : {}), ...(l.pullRequest !== undefined ? { pullRequest: l.pullRequest } : {}),
  };
}

/** What a timed-out job adds to its assessment's input (issue #630). */
export function timeoutInputOf(store: Reads, job: Job): { earlierTimeouts: TimeoutKind[]; liveness?: LivenessFacts } {
  const liveness = livenessOf(job);
  return { earlierTimeouts: earlierTimeoutsOf(store, job), ...(liveness ? { liveness } : {}) };
}
