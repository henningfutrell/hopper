// The shared rate limiter in the UI (ui/src/model/github-rate-limiter.ts, issue #436), pure: the summary of the
// settings, the change a save sends — only what differs, refused when a value is not a whole number in its range —, one
// line per rate-limit bucket, and the cache's hit rate.
import { describe, expect, it } from 'vitest';
import { bucketLine, cacheLine, rateLimiterPatch, rateLimiterSummary } from '../../ui/src/model/github-rate-limiter.ts';

const S = { slowBelowPercent: 25, reserve: 50, batchSize: 10, intakeReserve: 1000, intakeSyncMinutes: 15 };
const draft = (d: Partial<Record<keyof typeof S, string>>) => ({ slowBelowPercent: '25', reserve: '50', batchSize: '10', intakeReserve: '1000', intakeSyncMinutes: '15', ...d });

describe('the shared rate limiter model', () => {
  it('the summary says when calls slow, what is kept back and how polls run', () => {
    expect(rateLimiterSummary(S)).toBe('Calls slow below 25 % of a rate limit; 50 calls are kept in reserve; intake stops at 1000 calls left, for job work; intake lists the repositories every 15 min; GitHub watches poll 10 at a time.');
    expect(rateLimiterSummary({ slowBelowPercent: 0, reserve: 0, batchSize: 1, intakeReserve: 0, intakeSyncMinutes: 1 })).toBe('Calls slow only when none is left; no calls are kept in reserve; intake keeps no calls for job work; intake lists the repositories every minute; GitHub watches poll one at a time.');
  });

  it('a save sends only what differs; nothing differs, nothing to save', () => {
    expect(rateLimiterPatch(S, draft({}))).toEqual({ ok: true, patch: undefined });
    expect(rateLimiterPatch(S, draft({ reserve: ' 200 ', batchSize: '5' }))).toEqual({ ok: true, patch: { reserve: 200, batchSize: 5 } });
    expect(rateLimiterPatch(S, draft({ intakeReserve: '2000' }))).toEqual({ ok: true, patch: { intakeReserve: 2000 } });
    expect(rateLimiterPatch(S, draft({ intakeSyncMinutes: '30' }))).toEqual({ ok: true, patch: { intakeSyncMinutes: 30 } });
  });

  it('a value out of range, a fraction or no number is refused with the field named', () => {
    expect(rateLimiterPatch(S, draft({ slowBelowPercent: '101' }))).toEqual({ ok: false, error: 'Slow down below: a whole number from 0 to 100' });
    expect(rateLimiterPatch(S, draft({ reserve: '1.5' }))).toEqual({ ok: false, error: 'Reserve: a whole number from 0 to 5000' });
    expect(rateLimiterPatch(S, draft({ batchSize: '' }))).toEqual({ ok: false, error: 'Batch size: a whole number from 1 to 100' });
    expect(rateLimiterPatch(S, draft({ intakeReserve: '5001' }))).toEqual({ ok: false, error: 'Kept for job work: a whole number from 0 to 5000' });
    expect(rateLimiterPatch(S, draft({ intakeSyncMinutes: '0' }))).toEqual({ ok: false, error: 'Intake sync every: a whole number from 1 to 1440' });
  });

  it('a bucket: calls left of the limit, when it resets, and a hold after a refusal', () => {
    const now = 1_000_000;
    expect(bucketLine({ resource: 'core', limit: 5000, remaining: 4321, resetAt: now + 125_000 }, now)).toBe('core: 4321 of 5000 calls left, resets in 2 min 5 s');
    expect(bucketLine({ resource: 'graphql', limit: 5000, remaining: 0, resetAt: now + 30_000, holdUntil: now + 30_000 }, now))
      .toBe('graphql: 0 of 5000 calls left, resets in 30 s; held for 30 s after GitHub refused a call');
  });

  it('the cache: hits of all conditional answers', () => {
    expect(cacheLine({ entries: 120, hits: 360, misses: 120 })).toBe('120 answers kept; 360 of 480 answers were cache hits (75 %), each a call not spent.');
    expect(cacheLine({ entries: 0, hits: 0, misses: 0 })).toBe('No answers kept yet.');
  });
});
