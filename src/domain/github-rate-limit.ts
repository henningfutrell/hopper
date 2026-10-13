// The shared rate limiter (issue #436): one for every GitHub call and every GitHub watch, whatever credential makes them. Read
// from GitHub's rate-limit headers, it slows calls before the limit is near, spreads the calls left evenly over the time
// to the reset, and holds calls after GitHub refused one for its rate. Its thresholds are the instance's settings, kept
// in the database, changed by the hopper's admin on Settings → GitHub rate limit, and applied at once. Pure.

export interface RateLimiterSettings {
  /** Below this share of a bucket's limit, in percent, the calls left are spread over the time to the reset. */
  slowBelowPercent: number;
  /** Calls kept in reserve: at or below this many left, no call goes until the bucket resets. */
  reserve: number;
  /** Polls that run at the same time in one batch of a poll round. */
  batchSize: number;
  /**
   * Calls kept for job work (issue #983): at or below this many left, intake — the reads that look for new jobs — makes
   * no call until the bucket resets, so a job's reads and writes (its report, a rerun) still go. Never below `reserve`.
   */
  intakeReserve: number;
  /**
   * How often intake lists the job repositories again, in minutes (issue #985): one repository listing each time, the
   * listing cache in between. A sync a person asked for lists at once.
   */
  intakeSyncMinutes: number;
  /**
   * How often the in-motion cycle reads the pull requests in motion, in minutes (issue #985): one batched read each time.
   * Every followed pull request is read on the intake sync interval.
   */
  prCycleMinutes: number;
}

export const DEFAULT_RATE_LIMITER: RateLimiterSettings = { slowBelowPercent: 25, reserve: 50, batchSize: 10, intakeReserve: 1000, intakeSyncMinutes: 15, prCycleMinutes: 3 };

export const RATE_LIMITER_RANGES: Record<keyof RateLimiterSettings, { min: number; max: number }> = {
  slowBelowPercent: { min: 0, max: 100 },
  reserve: { min: 0, max: 5000 },
  batchSize: { min: 1, max: 100 },
  intakeReserve: { min: 0, max: 5000 },
  intakeSyncMinutes: { min: 1, max: 1440 },
  prCycleMinutes: { min: 1, max: 1440 },
};

/** A rate-limit bucket as GitHub last told it, per credential and resource; `holdUntil` after GitHub refused a call. */
export interface RateBucket {
  resource: string;
  limit: number;
  remaining: number;
  /** When the bucket resets, ms since the epoch. */
  resetAt: number;
  /** No call before this, ms since the epoch: GitHub refused one for its rate. */
  holdUntil?: number;
}

/** As GET /api/github-rate-limiter answers it: the settings, what GitHub last told of each bucket, the cache and the waits. */
export interface RateLimiterView {
  settings: RateLimiterSettings;
  /** One per credential and resource, the fewest calls left first; no credential is named. */
  buckets: RateBucket[];
  /** Conditional requests: answers kept, and how many GitHub answered 304 (a hit) or with new data (a miss). */
  cache: { entries: number; hits: number; misses: number };
  /** Calls the limiter made wait, and for how long in all, in ms. */
  waits: { count: number; totalMs: number };
}

type Headers = Record<string, string | number | undefined>;

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The bucket GitHub's `x-ratelimit-*` headers describe; undefined when they are missing. */
export function bucketFromHeaders(h: Headers): RateBucket | undefined {
  const limit = num(h['x-ratelimit-limit']);
  const remaining = num(h['x-ratelimit-remaining']);
  const reset = num(h['x-ratelimit-reset']);
  if (limit === undefined || remaining === undefined || reset === undefined) return undefined;
  return { resource: String(h['x-ratelimit-resource'] ?? 'core'), limit, remaining, resetAt: reset * 1000 };
}

/** The resource a call to `url` counts against, before GitHub says it. */
export function resourceOf(url: string): string {
  const path = new URL(url).pathname;
  if (/\/graphql$/.test(path)) return 'graphql';
  if (/\/search\//.test(path)) return 'search';
  return 'core';
}

/** How long a call waits before it goes, in ms. */
export function waitBefore(b: RateBucket | undefined, now: number, s: RateLimiterSettings): number {
  if (!b) return 0;
  if (b.holdUntil !== undefined && b.holdUntil > now) return b.holdUntil - now;
  if (b.resetAt <= now) return 0;
  const left = b.resetAt - now;
  if (b.remaining <= s.reserve) return left;
  if (b.remaining >= (b.limit * s.slowBelowPercent) / 100) return 0;
  return Math.ceil(left / (b.remaining - s.reserve));
}

const ONE_MINUTE = 60_000;

/**
 * When calls may go again after GitHub answered `status`: `retry-after` when it says it; a bucket with no calls left, its
 * reset; a 429 with neither, a minute. A 403 that is neither is no access, not a rate: undefined.
 */
export function holdAfter(status: number, h: Headers, now: number): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = num(h['retry-after']);
  if (retryAfter !== undefined) return now + retryAfter * 1000;
  const reset = num(h['x-ratelimit-reset']);
  if (num(h['x-ratelimit-remaining']) === 0 && reset !== undefined) return reset * 1000;
  return status === 429 ? now + ONE_MINUTE : undefined;
}

/** One batch of a poll round: the polls `from` (inclusive) `to` (exclusive), started `at` ms into the round. */
export interface PollBatch { at: number; from: number; to: number }

/** `count` polls in batches of `batchSize`, the batches spread evenly across `intervalMs`. */
export function pollPlan(count: number, intervalMs: number, batchSize: number): PollBatch[] {
  const batches = Math.ceil(count / batchSize);
  return Array.from({ length: batches }, (_, i) => ({
    at: Math.floor((i * intervalMs) / batches), from: i * batchSize, to: Math.min(count, (i + 1) * batchSize),
  }));
}
