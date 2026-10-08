// The UI session (design.md "UI session and mutations"): a one-time login code minted in the
// database (a device link's, for the user admin of an install from before), POST /ui/login → a page that stores the token in localStorage, and mutations only with that
// token in x-hopper-session plus exact Origin, same-origin Sec-Fetch-Site and a JSON body.
import { mintLoginCode } from '../../src/http/ui/login-code.ts';
import { openDb, parseDatabaseUrl } from '../../src/store/db.ts';
import { databaseUrlFor } from '../support/database.ts';
import { withInstance, writeConfig } from '../support/files.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_RE, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';

let t: TestApp;
let cleanup: () => void;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

/** A fresh code for admin, minted into the daemon's database as a device link mints it. */
const readCode = (): string => withInstance(t.dbPath, (instance) => mintLoginCode(instance, { now: () => new Date() }, 'admin'));
const login = (code: string, headers: Record<string, string> = {}) => rawRequest(t.url, {
  method: 'POST', path: '/ui/login', body: `code=${encodeURIComponent(code)}`,
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...headers },
});
const session = (token?: string) => rawRequest(t.url, { path: '/ui/api/session', headers: token ? { 'x-hopper-session': token } : {} });

describe('login', () => {
  it('a login code is 64 hex; the daemon writes no code anywhere', async () => {
    expect(readCode()).toMatch(/^[0-9a-f]{64}$/);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(t.dataDir).filter((f) => f.includes('login'))).toEqual([]);
  });

  it('the right code answers a page that stores the session token in localStorage jh_session and goes to /', async () => {
    const res = await login(readCode());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const token = TOKEN_RE.exec(res.text)?.[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.text).toMatch(/location\.replace\(\s*['"]\/['"]\s*\)/);
    const s = await session(token);
    expect(s.status).toBe(200);
    expect(JSON.parse(s.text)).toMatchObject({ authenticated: true, expiresAt: expect.any(String), user: { role: 'admin', realm: 'local' } });
  });

  it('a code works once; each minted code is its own', async () => {
    const first = readCode();
    const second = readCode();
    expect(second).not.toBe(first);
    expect((await login(first)).status).toBe(200);
    expect((await login(first)).status).toBe(403);
    expect((await login(second)).status).toBe(200);
  });

  it('a code expires ten minutes after it is minted', async () => {
    const { vi } = await import('vitest');
    const code = readCode();
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1000, toFake: ['Date'] });
    try {
      expect((await login(code)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wrong, empty or missing code is 403 and creates no session', async () => {
    expect((await login('0'.repeat(64))).status).toBe(403);
    expect((await login('')).status).toBe(403);
    expect((await rawRequest(t.url, { method: 'POST', path: '/ui/login', body: 'nothing=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
    expect(JSON.parse((await session('f'.repeat(64))).text)).toMatchObject({ authenticated: false });
    expect(JSON.parse((await session()).text)).toMatchObject({ authenticated: false });
  });

  it('logout drops the session', async () => {
    const token = await t.login();
    expect((await t.ui('/ui/api/logout', {}, { token })).status).toBe(200);
    expect(JSON.parse((await session(token)).text)).toMatchObject({ authenticated: false });
    expect((await t.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(403);
  });
});

describe('UI mutations', () => {
  it('succeed with a session, exact Origin (127.0.0.1 or localhost), same-origin fetch and JSON', async () => {
    const token = await t.login();
    expect((await t.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    const port = new URL(t.url).port;
    expect((await t.ui('/ui/api/queue-gate', { mode: 'auto-accept', autoAcceptPerHour: null }, { token, headers: { origin: `http://localhost:${port}`, host: `localhost:${port}` } })).status).toBe(200);
  });

  it.each([
    ['no session header', { headers: {} as Record<string, string | null> }, false],
    ['an unknown session token', { headers: { 'x-hopper-session': 'a'.repeat(64) } }, false],
    ['no Origin', { headers: { origin: null } }, true],
    ['a foreign Origin', { headers: { origin: 'http://evil.example' } }, true],
    ['an Origin on another port', { headers: { origin: 'http://127.0.0.1:1' } }, true],
    ['Origin null', { headers: { origin: 'null' } }, true],
    ['Sec-Fetch-Site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, true],
    ['Sec-Fetch-Site same-site', { headers: { 'sec-fetch-site': 'same-site' } }, true],
    ['a text/plain body', { headers: { 'content-type': 'text/plain' }, rawBody: '{"mode":"review","autoAcceptPerHour":null}' }, true],
    ['a form body', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'mode=review' }, true],
  ])('are 403 with %s, and change nothing', async (_name, o, withToken) => {
    const token = await t.login();
    const res = await t.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { ...(withToken ? { token } : {}), ...o });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toEqual(expect.any(String));
    expect((await t.api('GET', '/api/queue')).body.gate.mode).toBe('auto-accept');
  });

  it('every mutation route refuses a request without a session', async () => {
    for (const path of ['/ui/api/jobs/x/cancel', '/ui/api/jobs/x/approve', '/ui/api/questions/x/answer', '/ui/api/questions/x/close', '/ui/api/queue-gate', '/ui/api/logout']) {
      expect((await t.ui(path, {})).status, path).toBe(403);
    }
  });

  it('a session survives a daemon restart: same token, still authenticated, still mutates', async () => {
    const token = await t.login();
    const before = JSON.parse((await session(token)).text);
    await t.stop();
    t = await startTestApp({ dbPath: t.dbPath });
    const after = JSON.parse((await session(token)).text);
    expect({ ...after, signIn: undefined }).toEqual({ ...before, signIn: undefined });
    expect((await t.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
  });

  it('the store keeps only a hash of the session token, never the token', async () => {
    const token = await t.login();
    const raw = openDb(parseDatabaseUrl(databaseUrlFor(t.dbPath)));
    try {
      const rows = raw.all('SELECT * FROM ui_sessions');
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    } finally {
      raw.close();
    }
  });

  it('logout survives a restart too: a dropped token stays dropped', async () => {
    const token = await t.login();
    expect((await t.ui('/ui/api/logout', {}, { token })).status).toBe(200);
    await t.stop();
    t = await startTestApp({ dbPath: t.dbPath });
    expect(JSON.parse((await session(token)).text)).toMatchObject({ authenticated: false });
  });

  it('a session left alone for the idle timeout of the sign-in config expires', async () => {
    await t.stop();
    const db = tempDbPath();
    const prev = cleanup;
    cleanup = () => { prev(); db.cleanup(); };
    writeConfig(db.dbPath, 'sign-in', { version: 1, sessions: { idleHours: 0.00005, maxHours: 1 } }); // 180 ms
    t = await startTestApp({ dbPath: db.dbPath });
    const token = await t.login();
    expect(JSON.parse((await session(token)).text).authenticated).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse((await session(token)).text)).toMatchObject({ authenticated: false });
    expect((await t.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(403);
  });
});
