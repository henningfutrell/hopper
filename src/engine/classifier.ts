// Jev classification, off the decision path: advise each waiting job that has no advice yet.
import type { Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface Classifier {
  /** Start classifying every waiting job without advice that is not already in flight. */
  sweep(): void;
  /** Resolves when no classification is in flight. */
  idle(): Promise<void>;
}

export function createClassifier(c: EngineContext): Classifier {
  const inFlight = new Map<string, Promise<void>>();

  async function classify(job: Job): Promise<void> {
    const advice = await c.advisor.advise(job);
    if (c.stopping()) return;
    // Advice is recorded whatever the job's status now: in shadow mode a job may start, or
    // even finish, before Jev answers, and shadow mode exists to measure every job.
    const current = c.store.jobs.get(job.id);
    if (!current || current.jevAdvice) return;
    const mode = c.jevMode();
    c.store.tx(() => {
      c.store.jobs.update(job.id, { jevAdvice: advice });
      c.store.events.append({
        type: 'job.prioritized', jobId: job.id, data: { advice, mode, statusAtAdvice: current.status },
      });
    });
  }

  return {
    sweep() {
      if (c.stopping()) return;
      for (const job of c.store.jobs.list({ status: ['queued', 'held'] })) {
        if (job.jevAdvice || inFlight.has(job.id)) continue;
        const p = classify(job)
          .catch((e) => console.error('jev classification failed', job.id, e))
          .finally(() => inFlight.delete(job.id));
        inFlight.set(job.id, p);
      }
    },
    async idle() {
      await Promise.all(inFlight.values());
    },
  };
}
