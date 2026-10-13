// The shared rate limiter in the UI (issue #436), pure: the summary of the settings, the change a save sends, one line
// per rate-limit bucket, and the cache's hit rate. The intake reserve is issue #983's, the intake sync interval issue #985's.
import type { RateBucket, RateLimiterSettings, RateLimiterView } from './wire.ts';

/** Each setting's label and range, as the daemon allows it. */
const FIELDS: Record<keyof RateLimiterSettings, { label: string; min: number; max: number }> = {
  slowBelowPercent: { label: 'Slow down below', min: 0, max: 100 },
  reserve: { label: 'Reserve', min: 0, max: 5000 },
  batchSize: { label: 'Batch size', min: 1, max: 100 },
  intakeReserve: { label: 'Kept for job work', min: 0, max: 5000 },
  intakeSyncMinutes: { label: 'Intake sync every', min: 1, max: 1440 },
};

export type RateLimiterDraft = Record<keyof RateLimiterSettings, string>;

/** What is on now, in one sentence. */
export function rateLimiterSummary(s: RateLimiterSettings): string {
  const slow = s.slowBelowPercent === 0 ? 'Calls slow only when none is left' : `Calls slow below ${s.slowBelowPercent} % of a rate limit`;
  const reserve = s.reserve === 0 ? 'no calls are kept in reserve' : `${s.reserve} calls are kept in reserve`;
  const intake = s.intakeReserve === 0 ? 'intake keeps no calls for job work' : `intake stops at ${s.intakeReserve} calls left, for job work`;
  const every = s.intakeSyncMinutes === 1 ? 'intake lists the repositories every minute' : `intake lists the repositories every ${s.intakeSyncMinutes} min`;
  const batch = s.batchSize === 1 ? 'GitHub watches poll one at a time' : `GitHub watches poll ${s.batchSize} at a time`;
  return `${slow}; ${reserve}; ${intake}; ${every}; ${batch}.`;
}

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function rateLimiterPatch(s: RateLimiterSettings, d: RateLimiterDraft): { ok: true; patch: Partial<RateLimiterSettings> | undefined } | { ok: false; error: string } {
  const patch: Partial<RateLimiterSettings> = {};
  for (const key of Object.keys(FIELDS) as (keyof RateLimiterSettings)[]) {
    const { label, min, max } = FIELDS[key];
    const text = d[key].trim();
    const n = Number(text);
    if (text === '' || !Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${label}: a whole number from ${min} to ${max}` };
    if (n !== s[key]) patch[key] = n;
  }
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

const span = (ms: number): string => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m} min${sec % 60 ? ` ${sec % 60} s` : ''}` : `${sec} s`;
};

/** One bucket: calls left of the limit, when it resets, and a hold after GitHub refused a call. */
export function bucketLine(b: RateBucket, now: number): string {
  const line = `${b.resource}: ${b.remaining} of ${b.limit} calls left, resets in ${span(b.resetAt - now)}`;
  return b.holdUntil !== undefined && b.holdUntil > now ? `${line}; held for ${span(b.holdUntil - now)} after GitHub refused a call` : line;
}

/** The conditional requests' cache: how many of the answers were hits. */
export function cacheLine(c: RateLimiterView['cache']): string {
  const all = c.hits + c.misses;
  if (all === 0) return 'No answers kept yet.';
  return `${c.entries} answers kept; ${c.hits} of ${all} answers were cache hits (${Math.round((c.hits / all) * 100)} %), each a call not spent.`;
}
