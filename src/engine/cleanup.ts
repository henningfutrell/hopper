// Releasing what a job holds outside the process (its herdr pane). Called after the
// transaction that recorded a terminal outcome, and by restart recovery. Never throws.
import type { EngineContext } from './context.ts';

export type Cleanup = (jobId: string) => Promise<void>;

export function createCleanup(c: Pick<EngineContext, 'store' | 'executors' | 'keepPanes'>): Cleanup {
  return async (jobId) => {
    if (c.keepPanes) return;
    const job = c.store.jobs.get(jobId);
    const executor = job ? c.executors.get(job.spec.executor) : undefined;
    if (!job || !executor?.cleanup) return;
    try {
      await executor.cleanup(job);
    } catch (e) {
      console.error('executor cleanup failed', jobId, e);
    }
  };
}
