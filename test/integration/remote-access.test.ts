// Remote access (issue #880): the tunnel is set in the UI, never in a file on the host. Real daemon, real HTTP server, the
// real database. The tunnel service is played by requests to GET /tunnel/agent with the key HOPPER_TUNNEL_KEY gives; the
// ngrok agent's local API (HOPPER_TUNNEL_API) and the Grok Bot routine are loopback fakes.
//
// Feature: remote access from the UI
//   Scenario: on a fresh hopper with no tunnel variables, the admin sets the token and the domain and turns it on; the
//             tunnel service gets them, the URL is a public request's Host, and Grok Bot is told the URL
//   Scenario: the token is never answered but to the tunnel service, and never through the tunnel; a restart is new settings to it
//   Scenario: remote access is not turned on without a domain and a token; a bad domain or token is refused
//   Scenario: ngrok's error, reported by the tunnel service, is the status's error
//   Scenario: an install from before moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL into the settings, once
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteAccessView } from '../../src/domain/remote-access.ts';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const KEY = 'k'.repeat(64);
const TOKEN = '2abcDEFghiJKLmnoPQRstu_vwxYZ0123456789';
const DOMAIN = 'h.example.ngrok.app';
const URL_ = `https://${DOMAIN}`;

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  for (const c of cleanups.splice(0)) c();
});

async function serve(handle: (path: string, body: string) => string): Promise<string> {
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(handle(req.url ?? '', raw)); });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

async function boot(o: { env?: Record<string, string>; secrets?: Record<string, string>; dbPath?: string } = {}): Promise<TestApp> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath, ...(o.env ? { env: o.env } : {}), secrets: { HOPPER_TUNNEL_KEY: KEY, ...o.secrets }, seams: { grokbot: { baseMs: 20, watchMs: 20 } } });
  return t;
}

/** The tunnel service's ask, as compose.yaml's `tunnel` service makes it. */
const ask = (a: TestApp, o: { key?: string; report?: string; host?: string } = {}) => rawRequest(a.url, {
  path: `/tunnel/agent${o.report ? `?ngrok=${o.report}` : ''}`,
  headers: { ...(o.key === undefined ? { authorization: `Bearer ${KEY}` } : o.key === '' ? {} : { authorization: `Bearer ${o.key}` }), ...(o.host ? { host: o.host } : {}) },
});

const view = async (a: TestApp, token: string): Promise<RemoteAccessView> => (await a.api('GET', '/api/remote-access', undefined, { 'x-hopper-session': token })).body as RemoteAccessView;

describe('remote access from the UI (issue #880)', () => {
  it('a fresh hopper: the admin sets the token and the domain, turns it on; the tunnel service gets them and Grok Bot is told the URL', async () => {
    const agentApi = await serve(() => JSON.stringify({ tunnels: [{ public_url: URL_, proto: 'https' }] }));
    const hits: Record<string, unknown>[] = [];
    const routine = await serve((_p, body) => { hits.push(JSON.parse(body) as Record<string, unknown>); return '{}'; });
    const a = await boot({ env: { HOPPER_TUNNEL_API: agentApi }, secrets: { GROKBOT_WEBHOOK_URL: `${routine}/routine`, GROKBOT_WEBHOOK_KEY: 'sekrit' } });
    const token = await a.login();

    // Off, with a tunnel service that asks and is told nothing.
    expect(await view(a, token)).toMatchObject({ enabled: false, service: true, status: { state: 'off' } });
    expect((await ask(a)).status).toBe(204);
    // Before the domain is set, the domain's name is any other Host: 421.
    expect((await rawRequest(a.url, { path: '/api/state', headers: { host: DOMAIN } })).status).toBe(421);

    const on = await a.ui<RemoteAccessView>('/ui/api/remote-access', { authtoken: TOKEN, domain: `https://${DOMAIN.toUpperCase()}/`, enabled: true }, { token });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, domain: DOMAIN, url: URL_, authtoken: { last4: TOKEN.slice(-4) } });
    expect(JSON.stringify(on.body)).not.toContain(TOKEN);

    // The tunnel service gets the URL and the token, as lines its shell reads.
    const got = await ask(a, { report: 'running' });
    expect(got.status).toBe(200);
    expect(got.text).toBe(`url=${URL_}\nauthtoken=${TOKEN}\n`);
    expect(got.headers['cache-control']).toBe('no-store');

    // Up once the agent has an endpoint at the URL (the watch asks at once on a change); Grok Bot is told it.
    await waitFor(async () => ((await view(a, token)).status.state === 'up' ? true : undefined), { what: 'up', timeoutMs: 10_000 });
    expect((await view(a, token)).status).toMatchObject({ state: 'up', url: URL_ });
    const hit = await waitFor(() => hits.find((h) => h.kind === 'hopper.reachable'), { what: 'the announce', timeoutMs: 15_000 });
    expect(hit).toMatchObject({ url: URL_, apiTokenUrl: `${URL_}/ui/auth/api-token` });

    // The domain is now a public request's Host: the API only with a session.
    expect((await rawRequest(a.url, { path: '/api/state', headers: { host: DOMAIN } })).status).toBe(401);

    // Each change is an event, the token's value in none.
    const events = await a.events('types=remote_access.changed');
    expect(events.map((e) => e.data)).toEqual([expect.objectContaining({ from: { enabled: false }, to: { enabled: true, domain: DOMAIN }, authtoken: 'set' })]);
    expect(JSON.stringify(await a.events())).not.toContain(TOKEN);

    // Off: the service is told nothing, and the domain is any other Host again.
    expect((await a.ui<RemoteAccessView>('/ui/api/remote-access', { enabled: false }, { token })).body.status.state).toBe('off');
    expect((await ask(a)).status).toBe(204);
    expect((await rawRequest(a.url, { path: '/api/state', headers: { host: DOMAIN } })).status).toBe(421);
  }, 30_000);

  it('answers the token only to the tunnel service\'s key, never through the tunnel, and not at all without a tunnel service', async () => {
    const a = await boot();
    const token = await a.login();
    await a.ui('/ui/api/remote-access', { authtoken: TOKEN, domain: DOMAIN, enabled: true }, { token });
    expect((await ask(a, { key: '' })).status).toBe(401);
    expect((await ask(a, { key: 'x'.repeat(64) })).status).toBe(401);
    // Through the tunnel the Host is the domain: refused, whatever the key.
    expect((await ask(a, { host: DOMAIN })).status).toBe(404);
    expect((await ask(a)).status).toBe(200);
    // A restart is new settings to the tunnel service: it starts ngrok again.
    const before = (await ask(a)).text;
    const restarted = await a.ui<RemoteAccessView>('/ui/api/remote-access', { restart: true }, { token });
    expect(restarted.body.restartedAt).toEqual(expect.any(String));
    const after = (await ask(a)).text;
    expect(after).not.toBe(before);
    expect(after).toBe(`${before}restart=${restarted.body.restartedAt}\n`);
    await t!.stop();
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const plain = t;
    expect((await ask(plain)).status).toBe(404);
    const v = await view(plain, await plain.login());
    expect(v.service).toBe(false);
  });

  it('is not turned on without a domain and a token; a bad domain or token is refused; a token is not removed while on', async () => {
    const a = await boot();
    const token = await a.login();
    const post = (body: unknown) => a.ui<{ error?: string }>('/ui/api/remote-access', body, { token });
    expect((await post({ enabled: true })).status).toBe(409);
    expect((await post({ domain: DOMAIN, enabled: true })).body.error).toMatch(/needs the authtoken/);
    expect((await post({ domain: 'not a domain' })).status).toBe(400);
    expect((await post({ domain: 'localhost' })).status).toBe(400);
    expect((await post({ authtoken: 'has spaces in it and more' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ other: 1 })).status).toBe(400);
    expect((await post({ restart: true })).body.error).toMatch(/remote access is off/);
    expect((await post({ restart: false })).status).toBe(400);
    expect((await post({ authtoken: TOKEN, domain: DOMAIN, enabled: true })).status).toBe(200);
    expect((await post({ authtoken: null })).status).toBe(409);
    expect((await post({ enabled: false, authtoken: null })).status).toBe(200);
    expect((await view(a, token)).authtoken).toBeUndefined();
    // Only the hopper's admin: no session, no change.
    expect((await a.ui('/ui/api/remote-access', { enabled: false })).status).toBe(403);
  });

  it('says what ngrok refused, from the tunnel service\'s report, and that no tunnel service asks', async () => {
    const a = await boot({ env: { HOPPER_TUNNEL_API: 'http://127.0.0.1:1' } });
    const token = await a.login();
    await a.ui('/ui/api/remote-access', { authtoken: TOKEN, domain: DOMAIN, enabled: true }, { token });
    expect((await view(a, token)).status).toMatchObject({ state: 'no-service', error: expect.stringMatching(/has not asked/) });
    await ask(a, { report: 'ERR_NGROK_105' });
    expect((await view(a, token)).status).toMatchObject({ state: 'down', error: expect.stringMatching(/refused the authtoken.*ERR_NGROK_105/) });
    // A new token is tried afresh.
    await a.ui('/ui/api/remote-access', { authtoken: `${TOKEN}x` }, { token });
    await ask(a, { report: 'running' });
    expect((await view(a, token)).status.error).not.toMatch(/ERR_NGROK/);
    // A report that is not one is not kept.
    await ask(a, { report: 'rm%20-rf' });
    expect((await view(a, token)).status.error).not.toMatch(/rm/);
  });

  it('moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL of an install from before into the settings, once', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await boot({ dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: URL_ }, secrets: { NGROK_AUTHTOKEN: TOKEN } });
    const token = await a.login();
    expect(await view(a, token)).toMatchObject({ enabled: true, domain: DOMAIN, authtoken: { setBy: 'hopper', last4: TOKEN.slice(-4) } });
    // The admin turns it off; a start with the variable still in .env does not turn it on again.
    await a.ui('/ui/api/remote-access', { enabled: false }, { token });
    await a.stop();
    t = undefined;
    const again = await boot({ dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: URL_ }, secrets: { NGROK_AUTHTOKEN: TOKEN } });
    expect((await view(again, await again.login())).enabled).toBe(false);
  });
});
