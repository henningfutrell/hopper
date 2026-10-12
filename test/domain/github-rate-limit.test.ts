// Issue #436: the shared rate limiter's arithmetic. What GitHub's rate-limit headers say, how long a call waits before
// the limit is near, how long after GitHub refused one, and how polls spread across their interval. Pure.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_LIMITER, bucketFromHeaders, holdAfter, pollPlan, resourceOf, waitBefore,
} from '../../src/domain/github-rate-limit.ts';

const s = DEFAULT_RATE_LIMITER;

describe('the rate-limit headers', () => {
  it('give the bucket: its limit, the calls left and when it resets', () => {
    expect(bucketFromHeaders({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1000', 'x-ratelimit-resource': 'core' }))
      .toEqual({ resource: 'core', limit: 5000, remaining: 4990, resetAt: 1_000_000 });
  });

  it('missing or not numbers: no bucket', () => {
    expect(bucketFromHeaders({})).toBeUndefined();
    expect(bucketFromHeaders({ 'x-ratelimit-limit': 'x', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1' })).toBeUndefined();
  });

  it('the resource of a call comes from its path when GitHub has not said it yet', () => {
    expect(resourceOf('https://api.github.com/repos/o/r/issues/1')).toBe('core');
    expect(resourceOf('https://api.github.com/graphql')).toBe('graphql');
    expect(resourceOf('http://127.0.0.1:9/api/v3/search/issues?q=x')).toBe('search');
  });
});

describe('the wait before a call', () => {
  const bucket = (remaining: number) => ({ resource: 'core', limit: 5000, remaining, resetAt: 600_000 });

  it('no bucket yet, plenty left, or the bucket already reset: no wait', () => {
    expect(waitBefore(undefined, 0, s)).toBe(0);
    expect(waitBefore(bucket(4000), 0, s)).toBe(0);
    expect(waitBefore(bucket(10), 600_001, s)).toBe(0);
  });

  it('below the slow-down share: the calls left above the reserve spread evenly over the time to the reset', () => {
    // 25 % of 5000 is 1250; 1050 left, 50 in reserve: 1000 calls over 600 s, one each 600 ms.
    expect(waitBefore(bucket(1050), 0, s)).toBe(600);
    expect(waitBefore(bucket(150), 0, s)).toBe(6000);
  });

  it('at or below the reserve: wait for the reset', () => {
    expect(waitBefore(bucket(50), 100_000, s)).toBe(500_000);
    expect(waitBefore(bucket(0), 0, s)).toBe(600_000);
  });

  it('a hold after GitHub refused a call wins until it ends', () => {
    expect(waitBefore({ ...bucket(4000), holdUntil: 30_000 }, 10_000, s)).toBe(20_000);
    expect(waitBefore({ ...bucket(4000), holdUntil: 30_000 }, 30_000, s)).toBe(0);
  });
});

describe('the hold after a refusal', () => {
  it('a 429 or 403 with retry-after holds that long', () => {
    expect(holdAfter(429, { 'retry-after': '30' }, 1000)).toBe(31_000);
    expect(holdAfter(403, { 'retry-after': '5' }, 0)).toBe(5000);
  });

  it('a 403 or 429 with no calls left holds to the reset', () => {
    expect(holdAfter(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }, 0)).toBe(120_000);
  });

  it('a 429 with neither holds a minute; a plain 403 (no access) or any other status holds nothing', () => {
    expect(holdAfter(429, {}, 0)).toBe(60_000);
    expect(holdAfter(403, {}, 0)).toBeUndefined();
    expect(holdAfter(404, { 'retry-after': '5' }, 0)).toBeUndefined();
  });
});

describe('the poll plan', () => {
  it('splits the polls into batches and spreads the batches evenly across the interval', () => {
    expect(pollPlan(25, 60_000, 10)).toEqual([
      { at: 0, from: 0, to: 10 },
      { at: 20_000, from: 10, to: 20 },
      { at: 40_000, from: 20, to: 25 },
    ]);
  });

  it('no polls: no batches', () => {
    expect(pollPlan(0, 60_000, 10)).toEqual([]);
  });
});
