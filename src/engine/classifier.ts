// Router advice, off the decision path: advise each waiting job that has no advice yet.
import type { Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface Classifier {
  /** Advise on one job as soon as it is queued, whatever its status by the time the router answers. */
  classifyJob(jobId: string): void;
  /** Retry path: classify every waiting job without advice that is not already in flight. */
  sweep(): void;
  /** Resolves when no classification is in flight. */
  idle(): Promise<void>;
}

export function createClassifier(c: EngineContext): Classifier {
  const inFlight = new Map<string, Promise<void>>();

  async function classify(job: Job): Promise<void> {
    const advice = await c.router.advise(job);
    if (c.stopping()) return;
    // Advice is recorded whatever the job's status now: a job the user approved, or one cancelled,
    // may have moved on before the router answers.
    const current = c.store.jobs.get(job.id);
    if (!current || current.advice) return;
    c.store.tx(() => {
      c.store.jobs.update(job.id, { advice });
      c.store.events.append({
        type: 'job.prioritized', jobId: job.id, data: { advice, statusAtAdvice: current.status },
      });
    });
  }

  function launch(job: Job): void {
    if (c.stopping() || job.advice || inFlight.has(job.id)) return;
    const p = classify(job)
      .catch((e) => console.error('router advice failed', job.id, e))
      .finally(() => inFlight.delete(job.id));
    inFlight.set(job.id, p);
  }

  return {
    classifyJob(jobId) {
      const job = c.store.jobs.get(jobId);
      if (job) launch(job);
    },
    sweep() {
      for (const job of c.store.jobs.list({ status: ['queued', 'held'] })) launch(job);
    },
    async idle() {
      await Promise.all(inFlight.values());
    },
  };
}
