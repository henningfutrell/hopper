// The shared rate limiter (issue #436) on GitHub's calls: through `makeRequest`, as every GitHub adapter makes them,
// against a fake GitHub on loopback that keeps a real rate limit — it answers 403 when no call is left, and 304 to a
// conditional request whose ETag still matches, which costs no call. The clock is the test's: a wait moves it on.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITER } from '../../src/domain/github-rate-limit.ts';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { makeRequest } from '../../src/sources/github/app/http.ts';

const RESET_MS = 600_000;

interface FakeOpts { limit?: number; remaining?: number; changing?: boolean; refuseOnce?: { status: number; headers: Record<string, string> } }

/** A fake GitHub: issue `n` of o/r, its ETag, a rate limit per token that resets every 10 minutes of the test's clock. */
function fakeGitHub(clock: { t: number }, o: FakeOpts = {}) {
  const limit = o.limit ?? 5000;
  const seen = { calls: 0, ok: 0, notModified: 0, refused: 0, conditional: 0 };
  let remaining = o.remaining ?? limit;
  let resetAt = RESET_MS;
  let version = 0;
  let refuse = o.refuseOnce;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.calls++;
    // GitHub resets on a whole second, and says which.
    if (clock.t >= resetAt) { remaining = limit; resetAt = Math.ceil((clock.t + RESET_MS) / 1000) * 1000; }
    const rate = (left: number) => ({
      'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(left),
      'x-ratelimit-reset': String(Math.floor(resetAt / 1000)), 'x-ratelimit-resource': 'core',
    });
    if (refuse) {
      seen.refused++;
      res.writeHead(refuse.status, { 'content-type': 'application/json', ...rate(remaining), ...refuse.headers });
      refuse = undefined;
      return res.end(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }));
    }
    const n = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(req.url ?? '')?.[1];
    if (o.changing) version++;
    const etag = `"${n}-${version}"`;
    if (req.headers['if-none-match']) seen.conditional++;
    if (req.headers['if-none-match'] === etag) {
      seen.notModified++;
      res.writeHead(304, { etag, ...rate(remaining) });
      return res.end();
    }
    if (remaining <= 0) {
      seen.refused++;
      res.writeHead(403, { 'content-type': 'application/json', ...rate(0) });
      return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    }
    remaining--;
    seen.ok++;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', etag, ...rate(remaining) });
    res.end(JSON.stringify({ number: Number(n), title: `issue ${n}`, version }));
  });
  return { server, seen };
}

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

async function setup(o: FakeOpts = {}) {
  const clock = { t: 0 };
  const waits: number[] = [];
  const gh = fakeGitHub(clock, o);
  servers.push(gh.server);
  await new Promise<void>((r) => gh.server.listen(0, '127.0.0.1', r));
  const { port } = gh.server.address() as AddressInfo;
  const limiter = createGitHubLimiter({
    now: () => clock.t,
    // Waits run side by side: each ends at its own time, and the clock never goes back.
    sleep: async (ms) => { const until = clock.t + ms; waits.push(ms); await Promise.resolve(); clock.t = Math.max(clock.t, until); },
  });
  const req = makeRequest(`http://127.0.0.1:${port}`, limiter);
  const poll = (n: number) => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n, headers: { authorization: 'token t1' } });
  return { clock, waits, gh, limiter, req, poll };
}

const WATCHES = Array.from({ length: 120 }, (_, i) => i + 1);

describe('the shared rate limiter (issue #436)', () => {
  it('with 120 watches and plenty of calls left, nothing waits; a second round asks conditionally and every answer is a cache hit', async () => {
    const { gh, limiter, poll, waits } = await setup();
    const first = await Promise.all(WATCHES.map(poll));
    expect(first.map((r) => r.data.number)).toEqual(WATCHES);
    const second = await Promise.all(WATCHES.map(poll));
    expect(second.every((r) => r.status === 200)).toBe(true);
    expect(second.map((r) => r.data.title)).toEqual(WATCHES.map((n) => `issue ${n}`));
    expect(gh.seen).toMatchObject({ ok: 120, notModified: 120, conditional: 120, refused: 0 });
    expect(waits).toEqual([]);
    expect(limiter.view().cache).toEqual({ entries: 120, hits: 120, misses: 120 });
    expect(limiter.view().buckets).toEqual([{ resource: 'core', limit: 5000, remaining: 4880, resetAt: RESET_MS }]);
  });

  it('a change GitHub shows is a miss: the new data, and its new ETag kept', async () => {
    const { poll, limiter } = await setup({ changing: true });
    await poll(1);
    const r = await poll(1);
    expect(r.data.version).toBe(2);
    expect(limiter.view().cache).toMatchObject({ hits: 0, misses: 2 });
  });

  it('near the limit, polls slow before GitHub refuses any: 120 watches for 5 rounds on 300 calls left, never a 403', async () => {
    const { gh, poll, waits, limiter, clock } = await setup({ remaining: 300, changing: true });
    for (let round = 0; round < 5; round++) {
      const answers = await Promise.all(WATCHES.map(poll));
      expect(answers.every((a) => a.status === 200)).toBe(true);
    }
    expect(gh.seen.refused).toBe(0);
    expect(gh.seen.ok).toBe(600);
    expect(waits.length).toBeGreaterThan(0);
    // The 250 calls above the reserve are spread to the reset, the rest wait for it.
    expect(clock.t).toBeGreaterThanOrEqual(RESET_MS);
    expect(limiter.view().waits.count).toBe(waits.length);
  });

  it('a lower slow-down share and reserve applies to the next call', async () => {
    const { poll, waits, limiter } = await setup({ remaining: 1000 });
    // The first call learns the bucket, the next is spaced from it: the third waits.
    await poll(1);
    await poll(2);
    await poll(3);
    expect(waits).toHaveLength(1);
    limiter.configure({ ...DEFAULT_RATE_LIMITER, slowBelowPercent: 10, reserve: 0 });
    await poll(4);
    expect(waits).toHaveLength(1);
    expect(limiter.settings()).toMatchObject({ slowBelowPercent: 10, reserve: 0 });
  });

  it('after a 429 with retry-after, the next call waits that long', async () => {
    const { poll, waits, gh } = await setup({ refuseOnce: { status: 429, headers: { 'retry-after': '30' } } });
    await expect(poll(1)).rejects.toMatchObject({ status: 429 });
    await poll(1);
    expect(waits).toEqual([30_000]);
    expect(gh.seen.refused).toBe(1);
  });

  it('each credential has its own bucket, and its own cache', async () => {
    const { req, poll, limiter, gh } = await setup();
    await poll(1);
    await req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 1, headers: { authorization: 'token t2' } });
    expect(gh.seen.notModified).toBe(0);
    expect(limiter.view().buckets).toHaveLength(2);
    expect(JSON.stringify(limiter.view())).not.toMatch(/t1|t2/);
  });

  it('keeps at most the cache size, the least recently used out first', async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    servers.push(gh.server);
    await new Promise<void>((r) => gh.server.listen(0, '127.0.0.1', r));
    const limiter = createGitHubLimiter({ now: () => clock.t, cacheSize: 2 });
    const req = makeRequest(`http://127.0.0.1:${(gh.server.address() as AddressInfo).port}`, limiter);
    const poll = (n: number) => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n });
    await poll(1); await poll(2); await poll(1); await poll(3);
    expect(limiter.view().cache.entries).toBe(2);
    await poll(1);
    expect(gh.seen.notModified).toBe(2);
    await poll(2);
    expect(gh.seen.notModified).toBe(2);
  });
});
