// The UI session (design.md "UI session and mutations"): a one-time login code in a 0600 file,
// POST /ui/login → a page that stores the token in localStorage, and mutations only with that
// token in x-jobhopper-session plus exact Origin, same-origin Sec-Fetch-Site and a JSON body.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, parseDatabaseUrl } from '../../src/store/db.ts';
import { databaseUrlFor } from '../support/database.ts';
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

const codeFile = () => join(t.dataDir, 'ui-login-code');
const readCode = () => readFileSync(codeFile(), 'utf8').trim();
const login = (code: string, headers: Record<string, string> = {}) => rawRequest(t.url, {
  method: 'POST', path: '/ui/login', body: `code=${encodeURIComponent(code)}`,
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...headers },
});
const session = (token?: string) => rawRequest(t.url, { path: '/ui/api/session', headers: token ? { 'x-jobhopper-session': token } : {} });

describe('login', () => {
  it('writes a 64-hex login code at startup, mode 0600, in the data dir', () => {
    expect(readCode()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(codeFile()).mode & 0o777).toBe(0o600);
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
    expect(JSON.parse(s.text)).toEqual({ authenticated: true, expiresAt: expect.any(String) });
  });

  it('the code rotates on every use: the old code is refused, the new one works; the file stays 0600', async () => {
    const first = readCode();
    expect((await login(first)).status).toBe(200);
    const second = readCode();
    expect(second).not.toBe(first);
    expect(statSync(codeFile()).mode & 0o777).toBe(0o600);
    expect((await login(first)).status).toBe(403);
    expect((await login(second)).status).toBe(200);
  });

  it('a wrong, empty or missing code is 403 and creates no session', async () => {
    expect((await login('0'.repeat(64))).status).toBe(403);
    expect((await login('')).status).toBe(403);
    expect((await rawRequest(t.url, { method: 'POST', path: '/ui/login', body: 'nothing=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
    expect(JSON.parse((await session('f'.repeat(64))).text)).toEqual({ authenticated: false });
    expect(JSON.parse((await session()).text)).toEqual({ authenticated: false });
  });

  it('logout drops the session', async () => {
    const token = await t.login();
    expect((await t.ui('/ui/api/logout', {}, { token })).status).toBe(200);
    expect(JSON.parse((await session(token)).text)).toEqual({ authenticated: false });
    expect((await t.ui('/ui/api/router-mode', { mode: 'active' }, { token })).status).toBe(403);
  });
});

describe('UI mutations', () => {
  it('succeed with a session, exact Origin (127.0.0.1 or localhost), same-origin fetch and JSON', async () => {
    const token = await t.login();
    expect((await t.ui('/ui/api/router-mode', { mode: 'active' }, { token, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    const port = new URL(t.url).port;
    expect((await t.ui('/ui/api/router-mode', { mode: 'shadow' }, { token, headers: { origin: `http://localhost:${port}`, host: `localhost:${port}` } })).status).toBe(200);
  });

  it.each([
    ['no session header', { headers: {} as Record<string, string | null> }, false],
    ['an unknown session token', { headers: { 'x-jobhopper-session': 'a'.repeat(64) } }, false],
    ['no Origin', { headers: { origin: null } }, true],
    ['a foreign Origin', { headers: { origin: 'http://evil.example' } }, true],
    ['an Origin on another port', { headers: { origin: 'http://127.0.0.1:1' } }, true],
    ['Origin null', { headers: { origin: 'null' } }, true],
    ['Sec-Fetch-Site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, true],
    ['Sec-Fetch-Site same-site', { headers: { 'sec-fetch-site': 'same-site' } }, true],
    ['a text/plain body', { headers: { 'content-type': 'text/plain' }, rawBody: '{"mode":"active"}' }, true],
    ['a form body', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'mode=active' }, true],
  ])('are 403 with %s, and change nothing', async (_name, o, withToken) => {
    const token = await t.login();
    const res = await t.ui('/ui/api/router-mode', { mode: 'active' }, { ...(withToken ? { token } : {}), ...o });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toEqual(expect.any(String));
    expect((await t.api('GET', '/api/router')).body.mode).toBe('shadow');
  });

  it('every mutation route refuses a request without a session', async () => {
    for (const path of ['/ui/api/jobs/x/cancel', '/ui/api/jobs/x/approve', '/ui/api/questions/x/answer', '/ui/api/questions/x/close', '/ui/api/router-mode', '/ui/api/logout']) {
      expect((await t.ui(path, {})).status, path).toBe(403);
    }
  });

  it('a session survives a daemon restart: same token, still authenticated, still mutates', async () => {
    const token = await t.login();
    const before = JSON.parse((await session(token)).text);
    await t.stop();
    t = await startTestApp({ dbPath: t.dbPath });
    expect(JSON.parse((await session(token)).text)).toEqual(before);
    expect((await t.ui('/ui/api/router-mode', { mode: 'active' }, { token })).status).toBe(200);
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
    expect(JSON.parse((await session(token)).text)).toEqual({ authenticated: false });
  });

  it('a session expires after JOB_HOPPER_UI_SESSION_HOURS', async () => {
    await t.stop();
    const db = tempDbPath();
    const prev = cleanup;
    cleanup = () => { prev(); db.cleanup(); };
    t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_UI_SESSION_HOURS: '0.00005' } }); // 180 ms
    const token = await t.login();
    expect(JSON.parse((await session(token)).text).authenticated).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse((await session(token)).text)).toEqual({ authenticated: false });
    expect((await t.ui('/ui/api/router-mode', { mode: 'active' }, { token })).status).toBe(403);
  });
});
