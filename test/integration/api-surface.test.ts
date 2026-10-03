// What the HTTP surface still accepts: read-only GETs + SSE behind a Host guard, /api/sources,
// and nothing that pushes or mutates (those routes are gone, 404).
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceStatus } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeSourcesFile } from '../support/files.ts';
import { rawRequest } from '../support/http.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(before?: (dbPath: string) => void): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('removed inbound routes', () => {
  it.each([
    ['POST', '/api/jobs', { executor: 'test', payload: { op: 'echo' } }],
    ['POST', '/api/jobs/x/cancel', {}],
    ['POST', '/api/jobs/x/approve', {}],
    ['POST', '/api/questions/x/answer', { answer: 'y' }],
    ['POST', '/api/webhooks', { url: 'http://127.0.0.1:9/x' }],
    ['DELETE', '/api/webhooks/x', undefined],
    ['PUT', '/api/jev', { mode: 'active' }],
    ['PUT', '/api/usage/fake', { used: 1, limit: 2 }],
  ])('%s %s is 404', async (method, path, body) => {
    const a = await start();
    const res = await a.api(method, path, body);
    expect(res.status).toBe(404);
    expect((await a.api('GET', '/api/jobs')).body.jobs).toEqual([]);
    expect((await a.api('GET', '/api/jev')).body.mode).toBe('shadow');
  });
});

describe('Host guard (DNS rebinding)', () => {
  it('serves 127.0.0.1:<port> and localhost:<port>; any other Host is 421, GET and SSE included', async () => {
    const a = await start();
    const port = new URL(a.url).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await rawRequest(a.url, { path: '/api/health', headers: { host } })).status).toBe(200);
    }
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `localhost.evil:${port}`]) {
      const res = await rawRequest(a.url, { path: '/api/health', headers: { host } });
      expect(res.status, host).toBe(421);
      expect(JSON.parse(res.text).error).toMatch(/host/i);
    }
    expect((await rawRequest(a.url, { path: '/api/events/stream', headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await rawRequest(a.url, { path: '/', headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await rawRequest(a.url, { method: 'POST', path: '/ui/login', headers: { host: 'evil.example' }, body: 'code=x' })).status).toBe(421);
  });
});

describe('GET /api/sources', () => {
  it('lists the running sources with their sync status; no sources file → github disabled', async () => {
    const a = await start();
    await a.sync();
    const { sources } = (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body;
    expect(sources.find((s) => s.name === 'github')).toMatchObject({ kind: 'github', state: 'disabled' });
    expect(sources.find((s) => s.name === 'manual')).toMatchObject({ kind: 'manual', state: 'ok', lastSyncAt: expect.any(String) });
  });

  it('an invalid sources.yaml shows github in state error with the message, and nothing is pulled from it', async () => {
    const a = await start((db) => writeSourcesFile(db, 'version: 1\ngithub:\n  pollSeconds: -5\n'));
    const { sources } = (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body;
    const gh = sources.find((s) => s.name === 'github')!;
    expect(gh.state).toBe('error');
    expect(gh.lastError).toMatch(/pollSeconds/);
  });

  it('github enabled: false is listed disabled', async () => {
    const a = await start((db) => writeSourcesFile(db, { version: 1, github: { enabled: false } }));
    const { sources } = (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body;
    expect(sources.find((s) => s.name === 'github')).toMatchObject({ state: 'disabled' });
  });
});
