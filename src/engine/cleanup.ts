// Releasing what a job holds outside the process (its herdr pane) and reaping what it left (issue #401).
// Called after the transaction that recorded a terminal outcome, and by restart recovery. Never throws.
// A cleanup that could not reach the job's machine is deferred (issue #371): recorded on the job, tried
// again on every tick until it goes through, and meanwhile a waiting job of the same item is held.
import type { CleanupDue, Job } from '../domain/types.ts';
import { EngineError } from './errors.ts';
import { nowIso, type EngineContext } from './context.ts';

export type Cleanup = (jobId: string) => Promise<void>;

export interface Cleanups {
  run: Cleanup;
  /** Try every deferred cleanup again that is not running now. */
  retry(): void;
  /** The ended jobs whose cleanup is running or deferred: the decider holds a waiting job of the same item. */
  due(): CleanupDue[];
  /** The user closed what the deferred cleanup could not reach, by hand, or its machine is gone for good: no longer tried. */
  markCleanedUp(jobId: string): Job;
}

/** Statuses a job can end in with its cleanup due. */
const ENDED = ['finished', 'failed', 'cancelled'] as const;

export function createCleanups(c: Pick<EngineContext, 'store' | 'executors' | 'keepPanes' | 'clock' | 'trigger' | 'stopping'>): Cleanups {
  const running = new Set<string>();
  /** Deferred cleanups by job id: the job's item key, and why. Seeded from the store, so a restart keeps them. */
  const deferred = new Map<string, { sourceKey?: string; error: string }>();
  for (const job of c.keepPanes ? [] : c.store.jobs.list({ status: [...ENDED] })) {
    if (job.cleanupDeferred) deferred.set(job.id, { sourceKey: job.source?.key, error: job.cleanupDeferred.error });
  }

  const run: Cleanup = async (jobId) => {
    if (c.keepPanes || running.has(jobId)) return;
    const job = c.store.jobs.get(jobId);
    const executor = job ? c.executors.get(job.spec.executor) : undefined;
    if (!job || !executor?.cleanup) return;
    running.add(jobId);
    try {
      const reaped = await executor.cleanup(job);
      if (c.stopping()) return;
      deferred.delete(jobId);
      const was = c.store.jobs.get(jobId)?.cleanupDeferred;
      c.store.tx(() => {
        // Never removed silently (issue #401): what the reap kept is flagged on the job.
        if (reaped && reaped.kept.length > 0) c.store.events.append({ type: 'job.work_kept', jobId, data: { paths: reaped.kept } });
        if (was) {
          c.store.jobs.update(jobId, { cleanupDeferred: undefined });
          c.store.events.append({ type: 'job.cleaned_up', jobId, data: { deferredAt: was.at } });
        }
      });
    } catch (e) {
      if (c.stopping()) return;
      const error = e instanceof Error ? e.message : String(e);
      const first = !deferred.has(jobId);
      deferred.set(jobId, { sourceKey: job.source?.key, error });
      // Recorded once per deferral; a retry that fails again changes nothing.
      if (first && !c.store.jobs.get(jobId)?.cleanupDeferred) {
        console.error('executor cleanup deferred', jobId, error);
        c.store.tx(() => {
          c.store.jobs.update(jobId, { cleanupDeferred: { at: nowIso(c), error } });
          c.store.events.append({ type: 'job.cleanup_deferred', jobId, data: { error } });
        });
      }
    } finally {
      running.delete(jobId);
    }
    // A waiting job of the same item may be admitted now, or held with the new reason.
    c.trigger('cleanup');
  };

  return {
    run,
    retry() {
      for (const jobId of deferred.keys()) if (!running.has(jobId)) void run(jobId);
    },
    due() {
      const out: CleanupDue[] = [];
      for (const [jobId, d] of deferred) if (d.sourceKey) out.push({ jobId, sourceKey: d.sourceKey, error: d.error });
      for (const jobId of running) {
        if (deferred.has(jobId)) continue;
        const key = c.store.jobs.get(jobId)?.source?.key;
        if (key) out.push({ jobId, sourceKey: key });
      }
      return out.sort((a, b) => a.jobId.localeCompare(b.jobId));
    },
    markCleanedUp(jobId) {
      const job = c.store.jobs.get(jobId);
      if (!job) throw new EngineError('not_found', `job ${jobId} not found`);
      const was = job.cleanupDeferred;
      if (!was) throw new EngineError('conflict', `job ${jobId} has no deferred cleanup`);
      if (running.has(jobId)) throw new EngineError('conflict', `job ${jobId}'s cleanup is being tried now: try again`);
      deferred.delete(jobId);
      const next = c.store.tx(() => {
        const marked = c.store.jobs.update(jobId, { cleanupDeferred: undefined });
        c.store.events.append({ type: 'job.cleaned_up', jobId, data: { deferredAt: was.at, by: 'user' } });
        return marked;
      });
      c.trigger('cleanup');
      return next;
    },
  };
}
