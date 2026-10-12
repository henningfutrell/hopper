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
import { createHash } from 'node:crypto';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type { request as octokitRequest } from '@octokit/request';
import {
  DEFAULT_RATE_LIMITER, bucketFromHeaders, holdAfter, resourceOf, waitBefore,
  type RateBucket, type RateLimiterSettings, type RateLimiterView,
} from '../domain/github-rate-limit.ts';
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

/** How a caller waits: `deferAfterMs`, a longer wait is not waited (GitHubRateLimited). Absent: every wait is waited. */
export interface LimiterCall { deferAfterMs?: number }

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
      const gap = waitBefore({ ...known, remaining: known.remaining - known.pending }, at, settings);
      if (gap > 0 && ((known.holdUntil ?? 0) > at || known.remaining - known.pending <= settings.reserve)) {
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

  function keep(cacheKey: string, cached: Cached): void {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }

  async function hook(request: Request, options: Options, call: LimiterCall = {}): Promise<Response> {
    const parsed = request.endpoint.parse(options);
    const credential = createHash('sha256').update(String(parsed.headers.authorization ?? '')).digest('hex').slice(0, 16);
    const key = `${credential} ${resourceOf(parsed.url)}`;
    const isGet = parsed.method === 'GET';
    // Per credential, media type and URL: one URL asked as JSON and as raw text are two answers.
    const cacheKey = `${credential} ${String(parsed.headers.accept ?? '')} ${parsed.url}`;
    const cached = isGet ? cache.get(cacheKey) : undefined;
    const send = cached ? { ...options, headers: { ...options.headers, 'if-none-match': cached.etag } } : options;

    const counted = await admit(key, call);
    // Octokit's merged options keep the route's template (`/repos/{owner}/{repo}/issues`): one route, whatever the repository.
    traffic.call(parsed.method, String(options.url ?? parsed.url), (options as { query?: unknown }).query);
    let done!: () => void;
    if (!counted) probes.set(key, new Promise<void>((r) => { done = r; }));
    try {
      // Merged options always carry the route's url.
      const response = await request(send as typeof send & { url: string });
      learn(key, response.headers as Headers);
      if (isGet) {
        stats.misses++;
        const etag = response.headers.etag;
        if (typeof etag === 'string' && response.status === 200) keep(cacheKey, { etag, response });
      }
      return response;
    } catch (err) {
      const e = err as { status?: number; response?: { headers?: Headers } };
      learn(key, e.response?.headers, e.status);
      if (e.status === 304 && cached) {
        stats.hits++;
        keep(cacheKey, cached);
        return cached.response;
      }
      throw err;
    } finally {
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
    }),
  };
}

/** The one limiter of this process: every `makeRequest` uses it unless a test gives its own. */
export const githubLimiter = createGitHubLimiter();
