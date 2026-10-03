import type { Divergence, Job } from '../domain/types.ts';

export interface RouterVerdict {
  admit: boolean;
  /** Priority added to the job in active mode. */
  boost: number;
  /** Hold reason when `admit` is false. */
  reason: string;
}

/** Step 3: what the router's advice says about one waiting job. Computed in both modes. */
export function routerVerdict(job: Job, cheapBoost: number): RouterVerdict {
  const advice = job.advice;
  if (job.approved) return { admit: true, boost: 0, reason: '' };
  if (!advice) return { admit: false, boost: 0, reason: 'awaiting router advice' };
  switch (advice.action) {
    case 'ask_human':
      return { admit: false, boost: 0, reason: 'router ask_human: awaiting approval' };
    case 'stop_retry':
    case 'reuse_cache':
      return { admit: false, boost: 0, reason: `router ${advice.action}: ${advice.reason}` };
    case 'chat_only':
    case 'run_deterministic':
      return { admit: true, boost: cheapBoost, reason: '' };
    default:
      return { admit: true, boost: 0, reason: '' };
  }
}

/** A divergence exists when the advice would hold a natively startable job, or reorder it. */
export function divergence(job: Job, v: RouterVerdict): Divergence | undefined {
  const advice = job.advice;
  if (!advice) return undefined;
  if (!v.admit) {
    return { jobId: job.id, advice: advice.action, native: 'start', withAdvice: 'hold', note: v.reason };
  }
  if (v.boost !== 0) {
    return {
      jobId: job.id, advice: advice.action, native: 'start', withAdvice: 'start',
      note: `router ${advice.action}: priority +${v.boost}`,
    };
  }
  return undefined;
}
