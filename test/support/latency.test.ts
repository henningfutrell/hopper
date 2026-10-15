import { describe, expect, it } from 'vitest';
import { budget, perf, SLOW_MS } from './latency.ts';

describe('the latency budget (issue #1194)', () => {
  it('is 200 ms', () => {
    expect(budget({})).toBe(200);
    expect(budget({ CI: 'true' })).toBe(200);
  });

  it('takes a bound for one run, never one that lets a slowed seam pass', () => {
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: '500' })).toBe(500);
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: '5000' })).toBe(SLOW_MS / 2);
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: 'x' })).toBe(200);
  });

  it('is asserted off CI, and on CI only with HOPPER_PERF=1', () => {
    expect(perf({})).toBe(true);
    expect(perf({ CI: 'true' })).toBe(false);
    expect(perf({ CI: 'true', HOPPER_PERF: '1' })).toBe(true);
  });
});
