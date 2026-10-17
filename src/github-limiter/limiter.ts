// The shared rate limiter (issue #436, design.md "The shared rate limiter"): an `@octokit/request` hook every GitHub
// adapter's `makeRequest` carries, so every call and every GitHub watch goes through one limiter, per credential and
// resource. A bucket not known yet, or past its reset, lets one call go first and learn it; the others wait for its
// answer. Below the slow-down share, the calls left above the reserve are spaced evenly to the reset; at the reserve,
// calls wait for the reset; after a 403 or 429 for the rate, calls wait as long as GitHub said. A call counts against
// its bucket from when it is let go until GitHub answers, so a burst cannot spend more than is left. A GET carries the
// ETag of the answer kept for it, per credential, media type and URL (`If-None-Match`): a 304 costs no call and is answered from the cache.
// A call made with `deferAfterMs` (the job sources', issue #822) that would wait longer is not made: it throws
// GitHubRateLimited with the time it may go, so a sync pass ends and says when, instead of holding to the reset.
// Each call let go is counted for the sync pass it is made in (issue #858, `traffic.ts`).
// An intake call (`intake`, issue #983) also waits at the intake reserve, so intake never spends the calls job work needs.
// Each call GitHub charged — not a 304 — counts for the last hour under its kind (issue #985), a GraphQL call with the
// points it spent: the drop in its bucket's calls left since the last answer of the same window.
// Each call is a client span and is counted by route, status and cache use, and each bucket's calls left is a gauge
// (issue #1486, design.md "Telemetry"): the route's template, never its URL or credential. The telemetry summary keeps them too.
import { createHash } from 'node:crypto';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type { request as octokitRequest } from '@octokit/request';
import {
  DEFAULT_RATE_LIMITER, bucketFromHeaders, holdAfter, resourceOf, waitBefore,
  type GitHubCallKind, type RateBucket, type RateLimiterSettings, type RateLimiterView,
} from '../domain/github-rate-limit.ts';
import { instrument, tracer } from '../telemetry/instruments.ts';
import { telemetrySummary } from '../telemetry/summary.ts';
import { githubTraffic, type GitHubTraffic } from './traffic.ts';

type Request = typeof octokitRequest;
type Options = ReturnType<Request['endpoint']['merge']>;
type Response = Awaited<ReturnType<Request>>;

/** A call the limiter did not make (issue #822): it would wait longer than its caller allows. It may go at `retryAt`. */
export class GitHubRateLimited extends Error {
  readonly retryAt: number;
  constructor(retryAt: number) {
    super(`GitHub rate-limited the hopper: next retry at ${new Date(retryAt).toISOString().slice(11, 16)} UTC`);
    this.name = 'GitHubRateLimited';
    this.retryAt = retryAt;
  }
}

/**
 * How a caller waits: `deferAfterMs`, a longer wait is not waited (GitHubRateLimited). Absent: every wait is waited.
 * `intake`: a read that looks for new jobs; at the intake reserve or below it waits for the reset (issue #983).
 * `kind`: what the calls are for, when the caller knows it (a GitHub watch, a job's own request); else the read tells it (issue #985).
 */
export interface LimiterCall { deferAfterMs?: number; intake?: boolean; kind?: GitHubCallKind }

export interface GitHubLimiter {
  /** The `request.hook` of `@octokit/request`. */
  hook(request: Request, options: Options, call?: LimiterCall): Promise<Response>;
  configure(settings: RateLimiterSettings): void;
  settings(): RateLimiterSettings;
  view(): RateLimiterView;
}

interface Bucket extends RateBucket { pending: number; nextAt: number }
type Cached = { etag: string; response: Response };
type Headers = Record<string, string | number | undefined>;

const DEFAULT_CACHE_SIZE = 2000;

const githubCalls = instrument((m) => m.createCounter('hopper.github.calls', { description: 'GitHub API calls, by route, status and cache use.' }));
const githubDuration = instrument((m) => m.createHistogram('hopper.github.call.duration', { unit: 's', description: 'How long a GitHub API call took.' }));
const githubLeft = instrument((m) => m.createGauge('hopper.github.rate_limit.remaining', { description: 'The calls GitHub said are left, by resource.' }));

export function createGitHubLimiter(o: {
  now?: () => number; sleep?: (ms: number) => Promise<void>; cacheSize?: number; settings?: RateLimiterSettings; traffic?: GitHubTraffic;
} = {}): GitHubLimiter {
  const traffic = o.traffic ?? githubTraffic;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => sleepMs(ms).then(() => undefined));
  const cacheSize = o.cacheSize ?? DEFAULT_CACHE_SIZE;
  let settings = o.settings ?? DEFAULT_RATE_LIMITER;
  const buckets = new Map<string, Bucket>();
  const probes = new Map<string, Promise<unknown>>();
  const cache = new Map<string, Cached>();
  const stats = { hits: 0, misses: 0, waits: 0, waitedMs: 0 };

  const wait = async (ms: number) => { stats.waits++; stats.waitedMs += ms; await sleep(ms); };

  /** Waits until a call on `key` may go: the bucket it counts against, or undefined when it goes as the bucket's probe. */
  async function admit(key: string, call: LimiterCall): Promise<Bucket | undefined> {
    const defer = (t: number, ms: number) => { if (call.deferAfterMs !== undefined && ms > call.deferAfterMs) throw new GitHubRateLimited(t + ms); };
    for (;;) {
      const t = now();
      const b = buckets.get(key);
      if (b && b.resetAt <= t && (b.holdUntil ?? 0) <= t) buckets.delete(key);
      const known = buckets.get(key);
      if (!known) {
        const probe = probes.get(key);
        if (!probe) return undefined;
        await probe;
        continue;
      }
      // A call never goes before its slot; a slot at or past the reset waits for it, and a probe then learns the new window.
      const at = Math.max(t, known.nextAt);
      if (at > t && at >= known.resetAt) {
        defer(t, known.resetAt - t);
        await wait(known.resetAt - t);
        continue;
      }
      const left = known.remaining - known.pending;
      if (call.intake && left <= settings.intakeReserve && known.resetAt > t) {
        defer(t, known.resetAt - t);
        await wait(known.resetAt - t);
        continue;
      }
      const gap = waitBefore({ ...known, remaining: left }, at, settings);
      if (gap > 0 && ((known.holdUntil ?? 0) > at || left <= settings.reserve)) {
        defer(t, at + gap - t);
        await wait(at + gap - t);
        continue;
      }
      defer(t, at - t);
      known.pending++;
      if (gap > 0) known.nextAt = at + gap;
      if (at > t) await wait(at - t);
      return known;
    }
  }

  /**
   * What an answer says of its bucket; an answer from an older window, or one that says more calls are left than a
   * later one did, changes nothing. One with no rate-limit headers at all (a GitHub Enterprise Server with no limit) is
   * unlimited.
   */
  function learn(key: string, headers: Headers | undefined, status?: number): void {
    const seen = headers ? bucketFromHeaders(headers) : undefined;
    if (seen) githubLeft().record(seen.remaining, { 'hopper.github.resource': seen.resource });
    const b = buckets.get(key);
    if (headers && !seen && !b) {
      buckets.set(key, { resource: 'core', limit: 0, remaining: Infinity, resetAt: Infinity, pending: 0, nextAt: 0 });
      return;
    }
    const hold = status === undefined ? undefined : holdAfter(status, headers ?? {}, now());
    if (!b) {
      if (seen || hold !== undefined) buckets.set(key, { resource: 'core', limit: 0, remaining: 0, resetAt: 0, pending: 0, nextAt: 0, ...seen, ...(hold === undefined ? {} : { holdUntil: hold }) });
      return;
    }
    if (seen && (seen.resetAt > b.resetAt || (seen.resetAt === b.resetAt && seen.remaining < b.remaining))) {
      Object.assign(b, { resource: seen.resource, limit: seen.limit, remaining: seen.remaining, resetAt: seen.resetAt });
    }
    if (hold !== undefined) b.holdUntil = Math.max(hold, b.holdUntil ?? 0);
  }

  /**
   * The points a GraphQL answer spent (issue #985): the drop in calls left since the last answer of the same window; the
   * whole window's use when it is a new window; 1 when nothing was known before. A REST call spends no points.
   */
  function pointsOf(key: string, resource: string, headers: Headers | undefined): number {
    if (resource !== 'graphql') return 0;
    const seen = headers ? bucketFromHeaders(headers) : undefined;
    const b = buckets.get(key);
    if (!seen || !b || !Number.isFinite(b.remaining) || seen.resetAt < b.resetAt) return 1;
    if (seen.resetAt > b.resetAt) return Math.max(0, seen.limit - seen.remaining);
    return Math.max(0, b.remaining - seen.remaining);
  }

  function keep(cacheKey: string, cached: Cached): void {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }

  async function hook(request: Request, options: Options, call: LimiterCall = {}): Promise<Response> {
    const parsed = request.endpoint.parse(options);
    const credential = createHash('sha256').update(String(parsed.headers.authorization ?? '')).digest('hex').slice(0, 16);
    const resource = resourceOf(parsed.url);
    const key = `${credential} ${resource}`;
    const isGet = parsed.method === 'GET';
    // Per credential, media type and URL: one URL asked as JSON and as raw text are two answers.
    const cacheKey = `${credential} ${String(parsed.headers.accept ?? '')} ${parsed.url}`;
    const cached = isGet ? cache.get(cacheKey) : undefined;
    const send = cached ? { ...options, headers: { ...options.headers, 'if-none-match': cached.etag } } : options;

    // A bucket past its reset and its hold says nothing any more: a renewed token's old one goes (issue #1402).
    const t = now();
    for (const [k, b] of buckets) if (b.resetAt <= t && (b.holdUntil ?? 0) <= t && b.pending === 0) buckets.delete(k);
    const counted = await admit(key, call);
    // Octokit's merged options keep the route's template (`/repos/{owner}/{repo}/issues`): one route, whatever the repository.
    const route = String(options.url ?? parsed.url);
    const query = (options as { query?: unknown }).query;
    traffic.call(parsed.method, route, query);
    const charged = (headers: Headers | undefined) => traffic.charged(parsed.method, route, query, { ...(call.kind ? { kind: call.kind } : {}), points: pointsOf(key, resource, headers) });
    let done!: () => void;
    if (!counted) probes.set(key, new Promise<void>((r) => { done = r; }));
    const span = tracer().startSpan(`GitHub ${parsed.method} ${route}`, { kind: SpanKind.CLIENT, attributes: { 'http.request.method': parsed.method, 'url.template': route, 'hopper.github.resource': resource } });
    const from = performance.now();
    const measured = (status: number | undefined, cache: 'hit' | 'miss' | 'none'): void => {
      const attributes = { 'http.request.method': parsed.method, 'http.route': route, ...(status !== undefined ? { 'http.response.status_code': status } : {}), 'hopper.github.cache': cache };
      githubCalls().add(1, attributes);
      const seconds = (performance.now() - from) / 1000;
      githubDuration().record(seconds, attributes);
      telemetrySummary.githubCall(parsed.method, route, status, cache, seconds);
      span.setAttributes({ ...(status !== undefined ? { 'http.response.status_code': status } : {}), 'hopper.github.cache': cache });
      if (status === undefined || status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
    };
    try {
      // Merged options always carry the route's url.
      const response = await request(send as typeof send & { url: string });
      charged(response.headers as Headers);
      learn(key, response.headers as Headers);
      if (isGet) {
        stats.misses++;
        const etag = response.headers.etag;
        if (typeof etag === 'string' && response.status === 200) keep(cacheKey, { etag, response });
      }
      measured(response.status, isGet ? 'miss' : 'none');
      return response;
    } catch (err) {
      const e = err as { status?: number; response?: { headers?: Headers } };
      if (e.status !== undefined && e.status !== 304) charged(e.response?.headers);
      learn(key, e.response?.headers, e.status);
      if (e.status === 304 && cached) {
        stats.hits++;
        keep(cacheKey, cached);
        measured(304, 'hit');
        return cached.response;
      }
      measured(e.status, isGet ? 'miss' : 'none');
      throw err;
    } finally {
      span.end();
      if (counted) counted.pending--;
      else { probes.delete(key); done(); }
    }
  }

  return {
    hook,
    // New settings space the next call afresh: no slot kept from the old ones holds it.
    configure(s) { settings = { ...s }; for (const b of buckets.values()) b.nextAt = 0; },
    settings: () => ({ ...settings }),
    view: () => ({
      settings: { ...settings },
      buckets: [...buckets.values()].filter((b) => b.limit > 0)
        .map(({ resource, limit, remaining, resetAt, holdUntil }) => ({ resource, limit, remaining, resetAt, ...(holdUntil !== undefined && holdUntil > now() ? { holdUntil } : {}) }))
        .sort((a, b) => a.remaining - b.remaining || a.resource.localeCompare(b.resource)),
      cache: { entries: cache.size, hits: stats.hits, misses: stats.misses },
      waits: { count: stats.waits, totalMs: stats.waitedMs },
      hourly: traffic.hourly(),
    }),
  };
}

/** The one limiter of this process: every `makeRequest` uses it unless a test gives its own. */
export const githubLimiter = createGitHubLimiter();
