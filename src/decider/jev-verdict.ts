import type { Job, JevDivergence } from '../domain/types.ts';

export interface JevVerdict {
  admit: boolean;
  /** Priority added to the job in active mode. */
  boost: number;
  /** Hold reason when `admit` is false. */
  reason: string;
}

/** Step 3: what Jev says about one waiting job. Computed in both modes. */
export function jevVerdict(job: Job, cheapBoost: number): JevVerdict {
  const advice = job.jevAdvice;
  if (job.approved) return { admit: true, boost: 0, reason: '' };
  if (!advice) return { admit: false, boost: 0, reason: 'awaiting Jev classification' };
  switch (advice.action) {
    case 'ask_human':
      return { admit: false, boost: 0, reason: 'jev ask_human: awaiting approval' };
    case 'stop_retry':
    case 'reuse_cache':
      return { admit: false, boost: 0, reason: `jev ${advice.action}: ${advice.reason}` };
    case 'chat_only':
    case 'run_deterministic':
      return { admit: true, boost: cheapBoost, reason: '' };
    default:
      return { admit: true, boost: 0, reason: '' };
  }
}

/** A divergence exists when Jev would hold a natively startable job, or reorder it. */
export function divergence(job: Job, v: JevVerdict): JevDivergence | undefined {
  const advice = job.jevAdvice;
  if (!advice) return undefined;
  if (!v.admit) {
    return { jobId: job.id, advice: advice.action, native: 'start', withJev: 'hold', note: v.reason };
  }
  if (v.boost !== 0) {
    return {
      jobId: job.id, advice: advice.action, native: 'start', withJev: 'start',
      note: `jev ${advice.action}: priority +${v.boost}`,
    };
  }
  return undefined;
}
