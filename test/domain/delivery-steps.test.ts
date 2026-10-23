// Step estimates (issue #2554, design.md "Delivery forecasts"), pure: p50 and p90 of a delivery step from measured
// durations, with the sample size, and a low-confidence result with no number when there is too little history.
//
// Feature: step estimates
//   Scenario: enough samples give p50, p90 and the sample size
//   Scenario: fewer than the minimum give a low-confidence result, not a point guess
//   Scenario: a duration that is no number or below zero is not a sample
import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES, stepEstimate } from '../../src/domain/delivery-steps.ts';

const MIN = 60_000;
const minutes = (...m: number[]) => m.map((x) => x * MIN);

describe('stepEstimate', () => {
  it('ten samples: p50 and p90 by nearest rank, measured', () => {
    expect(stepEstimate('pr_checks', minutes(10, 1, 9, 2, 8, 3, 7, 4, 6, 5)))
      .toEqual({ step: 'pr_checks', samples: 10, confidence: 'measured', p50Ms: 5 * MIN, p90Ms: 9 * MIN });
  });
  it('exactly the minimum is measured', () => {
    expect(stepEstimate('coding', minutes(4, 2, 1, 3, 5), MIN_SAMPLES))
      .toEqual({ step: 'coding', samples: 5, confidence: 'measured', p50Ms: 3 * MIN, p90Ms: 5 * MIN });
  });
  it('fewer than the minimum: low confidence, no p50 or p90', () => {
    const e = stepEstimate('queued', minutes(1, 2, 3));
    expect(e).toEqual({ step: 'queued', samples: 3, confidence: 'low' });
    expect(e).not.toHaveProperty('p50Ms');
  });
  it('a duration that is no number or below zero is not a sample', () => {
    expect(stepEstimate('landing', [Number.NaN, -1, Infinity, ...minutes(1, 1, 1, 1)])).toEqual({ step: 'landing', samples: 4, confidence: 'low' });
  });
});
