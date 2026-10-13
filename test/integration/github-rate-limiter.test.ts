// The shared rate limiter's settings (issue #436): the instance's, in the database; the hopper's admin changes them at
// POST /ui/api/github-rate-limiter and the process's limiter takes them at once, with no restart; a restart keeps them.
// GET /api/github-rate-limiter shows what GitHub last told of each bucket, from any call made through `makeRequest`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITER, type RateLimiterView } from '../../src/domain/github-rate-limit.ts';
import { githubLimiter } from '../../src/github-limiter/limiter.ts';
import { makeRequest } from '../../src/sources/github/app/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const servers: Server[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<{ a: TestApp; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path });
  apps.push(a);
  return { a, dbPath: path };
}

const view = async (a: TestApp) => (await a.api('GET', '/api/github-rate-limiter')).body as RateLimiterView;

describe('the shared rate limiter settings (issue #436)', () => {
  it('start at the defaults; the admin changes one, it applies at once, is an event, and a restart keeps it', async () => {
    const { a, dbPath } = await boot();
    const token = await a.login();
    expect((await view(a)).settings).toEqual(DEFAULT_RATE_LIMITER);

    const r = await a.ui<RateLimiterView>('/ui/api/github-rate-limiter', { slowBelowPercent: 40, batchSize: 20 }, { token });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ ...DEFAULT_RATE_LIMITER, slowBelowPercent: 40, batchSize: 20 });
    expect(githubLimiter.settings()).toEqual(r.body.settings);
    expect((await a.events('types=github_rate_limiter.settings_changed'))[0]!.data).toMatchObject({
      from: DEFAULT_RATE_LIMITER, to: { slowBelowPercent: 40, reserve: 50, batchSize: 20 },
    });

    // The same values again: nothing changed, no event.
    await a.ui('/ui/api/github-rate-limiter', { slowBelowPercent: 40 }, { token });
    expect(await a.events('types=github_rate_limiter.settings_changed')).toHaveLength(1);

    await a.stop();
    apps.splice(0);
    githubLimiter.configure(DEFAULT_RATE_LIMITER);
    const { a: again } = await boot(dbPath);
    expect((await view(again)).settings).toEqual({ ...DEFAULT_RATE_LIMITER, slowBelowPercent: 40, batchSize: 20 });
    expect(githubLimiter.settings().batchSize).toBe(20);
  });

  it('the calls kept for job work (issue #983): the admin changes them, they apply at once, and a restart keeps them', async () => {
    const { a, dbPath } = await boot();
    const token = await a.login();
    expect((await view(a)).settings.intakeReserve).toBe(1000);
    const r = await a.ui<RateLimiterView>('/ui/api/github-rate-limiter', { intakeReserve: 2500 }, { token });
    expect(r.status).toBe(200);
    expect(githubLimiter.settings().intakeReserve).toBe(2500);
    expect((await a.events('types=github_rate_limiter.settings_changed'))[0]!.data).toMatchObject({
      from: { intakeReserve: 1000 }, to: { intakeReserve: 2500 },
    });
    await a.stop();
    apps.splice(0);
    githubLimiter.configure(DEFAULT_RATE_LIMITER);
    const { a: again } = await boot(dbPath);
    expect((await view(again)).settings).toEqual({ ...DEFAULT_RATE_LIMITER, intakeReserve: 2500 });
    githubLimiter.configure(DEFAULT_RATE_LIMITER);
  });

  it('refuses a value out of range, a fraction, an unknown setting and an empty change', async () => {
    const { a } = await boot();
    const token = await a.login();
    for (const body of [{ slowBelowPercent: 101 }, { reserve: -1 }, { batchSize: 0 }, { reserve: 1.5 }, { intakeReserve: 5001 }, { other: 1 }, {}]) {
      expect((await a.ui('/ui/api/github-rate-limiter', body, { token })).status).toBe(400);
    }
    expect((await view(a)).settings).toEqual(DEFAULT_RATE_LIMITER);
  });

  it('shows the bucket GitHub told of on a call made through makeRequest, and never the credential', async () => {
    const { a } = await boot();
    const gh = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"1"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '4102444800', 'x-ratelimit-resource': 'core' });
      res.end('{}');
    });
    servers.push(gh);
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    await makeRequest(`http://127.0.0.1:${(gh.address() as AddressInfo).port}`)('GET /rate-check', { headers: { authorization: 'token secret-436' } });
    const v = await view(a);
    expect(v.buckets).toContainEqual({ resource: 'core', limit: 5000, remaining: 4321, resetAt: 4_102_444_800_000 });
    expect(v.cache.entries).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(v)).not.toContain('secret-436');
  });
});
