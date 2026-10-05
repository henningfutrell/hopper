// The UI across the LAN (issue #16, design.md "Reaching the UI across the LAN"): with LAN names and
// LAN peers set, the daemon answers to those names; a LAN request reads /api/ only with a UI
// session, mutates with the LAN Origin, and a logged-in browser hands another device a login link.
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_RE, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';

let t: TestApp;
let cleanup: () => void;
let port: string;
let lanHost: string;
let lanOrigin: string;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env: { JOB_HOPPER_LAN_NAMES: 'server,server.lan', JOB_HOPPER_LAN_PEERS: '192.0.2.0/24' } });
  port = new URL(t.url).port;
  lanHost = `server:${port}`;
  lanOrigin = `http://${lanHost}`;
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

const lanGet = (path: string, headers: Record<string, string> = {}) => rawRequest(t.url, { path, headers: { host: lanHost, ...headers } });

/** Status and content type of a stream's first response, then hang up. */
const streamStatus = (path: string, headers: Record<string, string>) => new Promise<{ status: number; type: string }>((resolve, reject) => {
  const u = new URL(path, t.url);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
    resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '') });
    res.destroy();
  });
  req.on('error', reject);
  req.end();
});

const lanLogin = (code: string) => rawRequest(t.url, {
  method: 'POST', path: '/ui/login', body: `code=${encodeURIComponent(code)}`,
  headers: { host: lanHost, origin: lanOrigin, 'content-type': 'application/x-www-form-urlencoded' },
});

describe('the UI across the LAN', () => {
  it('the app and the session check answer a LAN name without a session; /api/ does not (401)', async () => {
    // 200 with a built UI, 503 without (ui/dist is not built in a fresh checkout); never refused.
    expect([200, 503]).toContain((await lanGet('/')).status);
    expect(JSON.parse((await lanGet('/ui/api/session')).text)).toMatchObject({ authenticated: false });
    for (const path of ['/api/health', '/api/queue', '/api/questions', '/api/jobs']) {
      const res = await lanGet(path);
      expect(res.status, path).toBe(401);
      expect(JSON.parse(res.text).error).toMatch(/log in/i);
    }
    expect((await streamStatus('/api/events/stream', { host: lanHost })).status).toBe(401);
  });

  it('with a UI session a LAN request reads /api/ (header) and the event stream (session query)', async () => {
    const token = await t.login();
    expect((await lanGet('/api/health', { 'x-jobhopper-session': token })).status).toBe(200);
    expect((await lanGet('/api/questions', { 'x-jobhopper-session': token })).status).toBe(200);
    const s = await streamStatus(`/api/events/stream?after=0&session=${token}`, { host: lanHost, accept: 'text/event-stream' });
    expect(s.status).toBe(200);
    expect(s.type).toMatch(/text\/event-stream/);
    expect((await lanGet('/api/health', { 'x-jobhopper-session': 'f'.repeat(64) })).status).toBe(401);
    expect((await lanGet(`/api/health?session=${token}`)).status).toBe(401);
  });

  it('loopback reads stay open without a session', async () => {
    expect((await rawRequest(t.url, { path: '/api/health' })).status).toBe(200);
  });

  it('mutations accept the LAN Origin with a session; another Origin is still 403', async () => {
    const token = await t.login();
    const mutate = (origin: string) => rawRequest(t.url, {
      method: 'POST', path: '/ui/api/router-mode', body: JSON.stringify({ mode: 'active' }),
      headers: { host: lanHost, origin, 'content-type': 'application/json', 'x-jobhopper-session': token, 'sec-fetch-site': 'same-origin' },
    });
    expect((await mutate(lanOrigin)).status).toBe(200);
    expect((await mutate(`http://server.lan:${port}`)).status).toBe(200);
    expect((await mutate('http://evil.example')).status).toBe(403);
    expect((await mutate(`http://server:${Number(port) + 1}`)).status).toBe(403);
  });

  it('a logged-in browser gets a device link per LAN name; the link logs another device in once', async () => {
    const token = await t.login();
    const res = await t.ui<{ links: string[] }>('/ui/api/device-link', {}, { token });
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(2);
    const [first, second] = res.body.links;
    expect(first).toMatch(new RegExp(`^http://server:${port}/#login=[0-9a-f]{64}$`));
    expect(second).toMatch(new RegExp(`^http://server\\.lan:${port}/#login=[0-9a-f]{64}$`));
    const code = new URL(first!).hash.slice('#login='.length);
    expect(new URL(second!).hash).toBe(`#login=${code}`);
    const login = await lanLogin(code);
    expect(login.status).toBe(200);
    const lanToken = TOKEN_RE.exec(login.text)?.[1];
    expect((await lanGet('/api/health', { 'x-jobhopper-session': lanToken! })).status).toBe(200);
    expect((await lanLogin(code)).status).toBe(403);
  });

  it('asked to keep a live code, the device link answers the same links; once the code is used, fresh ones (issue #95)', async () => {
    const token = await t.login();
    const first = (await t.ui<{ links: string[] }>('/ui/api/device-link', {}, { token })).body.links;
    const code = new URL(first[0]!).hash.slice('#login='.length);
    const kept = await t.ui<{ links: string[] }>('/ui/api/device-link', { keep: code }, { token });
    expect(kept.status).toBe(200);
    expect(kept.body.links).toEqual(first);

    expect((await lanLogin(code)).status).toBe(200);
    const fresh = (await t.ui<{ links: string[] }>('/ui/api/device-link', { keep: code }, { token })).body.links;
    expect(fresh).toHaveLength(2);
    const next = new URL(fresh[0]!).hash.slice('#login='.length);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(code);
    expect((await lanLogin(next)).status).toBe(200);
  });

  it('keep that is no login code gets fresh links, never an echo of it', async () => {
    const token = await t.login();
    const res = await t.ui<{ links: string[] }>('/ui/api/device-link', { keep: 'f'.repeat(64) }, { token });
    expect(res.status).toBe(200);
    expect(res.body.links[0]).not.toContain('f'.repeat(64));
  });

  it('a device link needs a session', async () => {
    expect((await t.ui('/ui/api/device-link', {})).status).toBe(403);
  });

  it('a question link in a notification names the first LAN name', () => {
    expect(t.app.answerUrl('q1')).toBe(`http://server:${port}/#question-q1`);
  });
});

describe('without LAN names', () => {
  it('a device link is refused (409): there is no other name to reach', async () => {
    const db = tempDbPath();
    const local = await startTestApp({ dbPath: db.dbPath });
    try {
      const token = await local.login();
      const res = await local.ui<{ error: string }>('/ui/api/device-link', {}, { token });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/JOB_HOPPER_LAN_NAMES/);
      expect(local.app.answerUrl('q1')).toBe(`${local.url}/#question-q1`);
    } finally {
      await local.stop();
      db.cleanup();
    }
  });
});
