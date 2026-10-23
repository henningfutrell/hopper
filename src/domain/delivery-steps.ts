// Delivery steps (issue #2554, design.md "Delivery forecasts"): the steps a change takes from the queue to production,
// and the estimate of one step from its measured durations. Pure.

/** The steps, in order. A repository that has no step of these (no test gate) takes no time in it. */
export const DELIVERY_STEPS = ['queued', 'coding', 'pr_checks', 'landing', 'landing_checks', 'promotion_set', 'test_gate', 'production'] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

/** The steps whose times the promotion sets fix: they are scheduled, not measured. */
export const SCHEDULED_STEPS: readonly DeliveryStep[] = ['promotion_set', 'test_gate', 'production'];

/** What holds a slipping change. A fixed set. */
export const BLOCKERS = ['human_gate', 'ci_red', 'conflict', 'queue', 'rollout_failed'] as const;
export type Blocker = (typeof BLOCKERS)[number];

/** The blocker of a step that slips when the change names none; a delivery gate's is always `human_gate`. */
export const DEFAULT_BLOCKER: Record<DeliveryStep, Blocker> = {
  queued: 'queue', coding: 'queue', pr_checks: 'ci_red', landing: 'conflict', landing_checks: 'ci_red',
  promotion_set: 'queue', test_gate: 'human_gate', production: 'rollout_failed',
};

/** Fewer samples than this give a low-confidence estimate, with no number. */
export const MIN_SAMPLES = 5;

/** One step's estimate: its p50 and p90 from enough samples, or `low` and none. */
export type StepEstimate =
  | { step: DeliveryStep; samples: number; confidence: 'measured'; p50Ms: number; p90Ms: number }
  | { step: DeliveryStep; samples: number; confidence: 'low' };

/** The nearest-rank percentile `p` (0..1) of sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/** A step's estimate from its measured durations in ms; a value that is no finite number or below zero is not a sample. */
export function stepEstimate(step: DeliveryStep, durationsMs: readonly number[], minSamples = MIN_SAMPLES): StepEstimate {
  const sorted = durationsMs.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (sorted.length < Math.max(1, minSamples)) return { step, samples: sorted.length, confidence: 'low' };
  return { step, samples: sorted.length, confidence: 'measured', p50Ms: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
}
