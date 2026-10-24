// What the failure assessor reads and does for a heap abort pattern (issue #2722, design.md "Heap abort patterns",
// `heap-pattern.ts`). The reap records a heap abort when the job's cleanup ends, which can be after the job's assessment: so
// a run again the assessment made pending is held too, when the pattern shows before it runs — at the job's
// `job.heap_aborted`, and again before the sweep makes it. Only the assessor's own runs again: a release is a person's
// or a check's.
import type { UserStore } from '../domain/ports.ts';
import type { FailureSettings, Job, Problem } from '../domain/types.ts';
import { abortedCommandOf } from '../domain/heap-retry.ts';
import { backoffMs, duration } from './assess.ts';
import { HEAP_ABORT_CAUSE, HEAP_PATTERN_WINDOW_MS, heapAbortsSeen, heapPatternOf, type HeapPattern } from './heap-pattern.ts';

/** The jobs of a chain of runs a heap retry looks back through. */
const CHAIN_MAX = 20;

/** Whether job `jobId`, or a job of the chain of runs before it, had its heap retry (issue #2722 part 4, `job.heap_retry`). */
export function heapRetriedIn(store: Pick<UserStore, 'events' | 'jobs'>, jobId: string | undefined): boolean {
  for (let id = jobId, n = 0; id !== undefined && n < CHAIN_MAX; id = store.jobs.get(id)?.rerunOf, n += 1) {
    if (store.events.recent(1, ['job.heap_retry'], id).length > 0) return true;
  }
  return false;
}

export interface HeapHolds {
  /** The pattern the failed job is part of, and the open problem of its command; undefined: none. */
  patternOf(job: Job): { pattern: HeapPattern; open?: Problem } | undefined;
  /** The command the failed job ran out of heap with, when it may have its heap retry: none in its chain yet. */
  retryOf(job: Job): { command: string } | undefined;
  /** Hold the job's pending run again on its pattern's problem, in its own transaction: whether it held it. */
  holdPending(jobId: string): boolean;
  /**
   * A heap abort read after the assessment handed the job to a person (part 4): its record becomes its heap retry, a run again
   * pending after the first backoff, while no person, Jev or run again took it. Whether it did.
   */
  retryPending(jobId: string): boolean;
}

export function createHeapHolds(o: { store: UserStore; now: () => Date; settings: () => FailureSettings }): HeapHolds {
  const { store } = o;
  function patternOf(job: Job): { pattern: HeapPattern; open?: Problem } | undefined {
    if (store.events.recent(1, ['job.heap_aborted'], job.id).length === 0) return undefined;
    const since = new Date(o.now().getTime() - HEAP_PATTERN_WINDOW_MS).toISOString();
    const resolvedAt: Record<string, string> = {};
    for (const p of store.problems.list({ status: 'resolved' })) {
      if (p.causeId === HEAP_ABORT_CAUSE && p.resolvedAt && !(resolvedAt[p.signature] && resolvedAt[p.signature]! >= p.resolvedAt)) resolvedAt[p.signature] = p.resolvedAt;
    }
    const seen = heapAbortsSeen([...store.events.between(['job.heap_aborted'], since), ...store.events.recent(20, ['job.heap_aborted'], job.id)]);
    const pattern = heapPatternOf(seen, job.id, o.settings().groupThreshold, since, resolvedAt);
    if (!pattern) return undefined;
    const open = store.problems.open(pattern.signature);
    return { pattern, ...(open ? { open } : {}) };
  }

  const holdPending = (jobId: string): boolean => store.tx(() => {
    const r = store.failures.forJob(jobId), job = store.jobs.get(jobId);
    if (!r?.pending || r.pending === 'release' || !job || job.status !== 'failed' || !o.settings().auto.hold) return false;
    const found = patternOf(job);
    if (!found) return false;
    const { pattern, open } = found, at = o.now().toISOString();
    const problem = open
      ? store.problems.update(open.id, { jobIds: [...open.jobIds, jobId], updatedAt: at })
      : store.problems.create({ signature: pattern.signature, title: pattern.title, causeId: HEAP_ABORT_CAUSE, decision: 'hold', scope: {}, status: 'open', general: false, openedAt: at, updatedAt: at, jobIds: [jobId] });
    const reasons = [pattern.reason, ...r.reasons];
    const summary = `Held: ${problem.title}. ${r.summary.slice(r.summary.indexOf('. ') + 2)}`;
    store.failures.update(r.id, { cls: 'shared', decision: 'hold', reasons, summary, problemId: problem.id, pending: undefined, pendingAt: undefined, retryAt: undefined, outcome: 'held', outcomeAt: at });
    if (job.assessment) store.jobs.update(jobId, { assessment: { ...job.assessment, class: 'shared', decision: 'hold', reasons, summary, problemId: problem.id, problemTitle: problem.title, retryAt: undefined } });
    store.events.append({
      type: 'failure.grouped', jobId,
      data: { problemId: problem.id, signature: pattern.signature, title: problem.title, opened: !open, general: false, decision: 'hold', scope: {}, affected: problem.jobIds.length },
    });
    return true;
  });

  const retryOf = (job: Job): { command: string } | undefined => {
    const command = abortedCommandOf(store.events.recent(20, ['job.heap_aborted'], job.id));
    return command !== undefined && !heapRetriedIn(store, job.id) ? { command } : undefined;
  };

  const retryPending = (jobId: string): boolean => store.tx(() => {
    const r = store.failures.forJob(jobId), job = store.jobs.get(jobId), s = o.settings();
    if (!r || r.decision !== 'person' || r.pending || r.outcome !== 'surfaced' || r.jev || r.cls === 'shared' || !job || job.status !== 'failed' || job.dismissedAt || !s.auto.retry) return false;
    const retry = retryOf(job);
    if (!retry || patternOf(job)) return false;
    const at = o.now(), retryInMs = backoffMs(1, s), retryAt = new Date(at.getTime() + retryInMs).toISOString();
    const reasons = [`${retry.command} ran out of heap: it runs again once, with a larger heap when its machine has room`, ...r.reasons];
    const summary = `Heap retry in ${duration(retryInMs)}. ${r.summary.slice(r.summary.indexOf('. ') + 2)}`;
    store.failures.update(r.id, { cls: 'transient', decision: 'retry', reasons, summary, pending: 'retry', pendingAt: retryAt, retryAt, outcome: undefined, outcomeAt: undefined });
    if (job.assessment) store.jobs.update(jobId, { assessment: { ...job.assessment, class: 'transient', decision: 'retry', reasons, summary, retryAt } });
    return true;
  });

  return { patternOf, retryOf, holdPending, retryPending };
}
