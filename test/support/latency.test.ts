import { describe, expect, it } from 'vitest';
import { budget, SLOW_MS } from './latency.ts';

describe('the latency budget (issue #1194)', () => {
  it('is 200 ms on a developer machine', () => {
    expect(budget({})).toBe(200);
  });

  it('is looser on CI, but under what a slowed seam takes', () => {
    expect(budget({ CI: 'true' })).toBe(1000);
    expect(budget({ CI: 'true' })).toBeLessThan(SLOW_MS);
  });

  it('takes a bound for one run, never one that lets a slowed seam pass', () => {
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: '500' })).toBe(500);
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: '5000' })).toBe(SLOW_MS / 2);
    expect(budget({ HOPPER_TEST_LATENCY_BUDGET_MS: 'x' })).toBe(200);
  });
});
