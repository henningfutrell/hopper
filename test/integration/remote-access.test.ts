// Remote access (issues #880, #968): off by default; the admin picks Cloudflare Tunnel or ngrok, gives its one credential,
// and turns it on; the hopper mints the tunnel itself and removes it again. Real daemon, real HTTP server, the real
// database. The tunnel services are played by requests to GET /tunnel/agent with the key HOPPER_TUNNEL_KEY gives;
// Cloudflare's and ngrok's APIs, the agents' local APIs and the Grok Bot routine are loopback fakes.
//
// Feature: remote access minted by the hopper
//   Scenario: a fresh hopper: off, nothing asked for; Cloudflare with its API token alone reaches a working URL; off again
//             removes the tunnel and its DNS record
//   Scenario: switching to ngrok removes Cloudflare's tunnel and mints ngrok's authtoken and domain
//   Scenario: it is not turned on without a provider and its credential; a provider's refusal leaves it off, nothing minted
//   Scenario: what a release cannot remove is named, and remote access is off all the same
//   Scenario: the token is never answered but to its tunnel service, and never through the tunnel; a restart is new settings
//   Scenario: ngrok's error, reported by the tunnel service, is the status's error
//   Scenario: an install from before moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL into the settings, once, and keeps them off
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteAccessView } from '../../src/domain/remote-access.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { fakeCloudflare, fakeNgrok, type Fake, type FakeCloudflare, type FakeNgrok } from '../remote-access/fake-providers.ts';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const KEY = 'k'.repeat(64);
const CF = 'c'.repeat(40);
const NG = 'n'.repeat(40);
const HAND = '2abcDEFghiJKLmnoPQRstu_vwxYZ0123456789';
const CF_HOST = 'hopper.example.com';
const NG_HOST = 'mine.ngrok-free.app';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
const servers: Server[] = [];
const fakes: Fake[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  for (const f of fakes.splice(0)) await f.close();
  for (const c of cleanups.splice(0)) c();
});

async function serve(handle: (path: string, body: string) => { status?: number; body: string }): Promise<string> {
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { const r = handle(req.url ?? '', raw); res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }); res.end(r.body); });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

interface Booted { a: TestApp; cf: FakeCloudflare; ng: FakeNgrok }

async function boot(o: { env?: Record<string, string>; secrets?: Record<string, string>; dbPath?: string } = {}): Promise<Booted> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  const cf = await fakeCloudflare({ token: CF });
  const ng = await fakeNgrok({ key: NG, domains: { rd_own: NG_HOST } });
  fakes.push(cf, ng);
  t = await startTestApp({
    dbPath, ...(o.env ? { env: o.env } : {}), secrets: { HOPPER_TUNNEL_KEY: KEY, ...o.secrets },
    seams: { grokbot: { baseMs: 20, watchMs: 20 }, tunnelProviders: { cloudflare: cloudflareProvider({ base: cf.url }), ngrok: ngrokProvider({ base: ng.url }) } },
  });
  return { a: t, cf, ng };
}

/** A tunnel service's ask, as compose.yaml's `tunnel` (ngrok) and `cloudflared` services make it. */
const ask = (a: TestApp, o: { key?: string; agent?: 'ngrok' | 'cloudflared'; report?: string; host?: string } = {}) => rawRequest(a.url, {
  path: `/tunnel/agent?${o.agent ?? 'ngrok'}=${o.report ?? 'stopped'}`,
  headers: { ...(o.key === undefined ? { authorization: `Bearer ${KEY}` } : o.key === '' ? {} : { authorization: `Bearer ${o.key}` }), ...(o.host ? { host: o.host } : {}) },
});

const view = async (a: TestApp, token: string): Promise<RemoteAccessView> => (await a.api('GET', '/api/remote-access', undefined, { 'x-hopper-session': token })).body as RemoteAccessView;
const post = (a: TestApp, token: string, body: unknown) => a.ui<RemoteAccessView & { error?: string }>('/ui/api/remote-access', body, { token });

describe('remote access minted by the hopper (issue #968)', () => {
  it('a fresh hopper is off; Cloudflare\'s API token alone reaches a working URL; off removes the tunnel and its DNS record', async () => {
    const ready = await serve((p) => (p === '/ready' ? { body: '{"status":200,"readyConnections":4}' } : { status: 404, body: '{}' }));
    const hits: Record<string, unknown>[] = [];
    const routine = await serve((_p, body) => { hits.push(JSON.parse(body) as Record<string, unknown>); return { body: '{}' }; });
    const { a, cf } = await boot({ env: { HOPPER_CLOUDFLARED_API: ready }, secrets: { GROKBOT_WEBHOOK_URL: `${routine}/routine`, GROKBOT_WEBHOOK_KEY: 'sekrit' } });
    const token = await a.login();

    // Off by default: nothing minted, no tunnel service told anything.
    expect(await view(a, token)).toMatchObject({ enabled: false, credentials: {}, service: true, status: { state: 'off' } });
    expect((await ask(a, { agent: 'cloudflared' })).status).toBe(204);
    expect((await ask(a)).status).toBe(204);
    expect(cf.calls).toEqual([]);

    const on = await post(a, token, { provider: 'cloudflare', credential: ` ${CF} `, enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({
      enabled: true, provider: 'cloudflare', url: `https://${CF_HOST}`, provisioned: { provider: 'cloudflare', domain: CF_HOST },
      credentials: { cloudflare: { last4: CF.slice(-4) } },
      links: { url: `https://${CF_HOST}`, api: `https://${CF_HOST}/api/`, apiToken: `https://${CF_HOST}/ui/auth/api-token`, tokenRefresh: `https://${CF_HOST}/ui/auth/token/refresh` },
    });
    expect(JSON.stringify(on.body)).not.toContain(CF);
    expect(cf.tunnels.size).toBe(1);
    expect([...cf.records.values()]).toEqual([expect.objectContaining({ name: CF_HOST, proxied: true })]);

    // The cloudflared service gets the tunnel's token; the ngrok service is told nothing.
    const got = await ask(a, { agent: 'cloudflared', report: 'running' });
    expect(got.status).toBe(200);
    expect(got.text).toBe('token=cf-tunnel-token-tun1\n');
    expect(got.headers['cache-control']).toBe('no-store');
    expect((await ask(a, { report: 'running' })).status).toBe(204);

    // Up once cloudflared is ready; Grok Bot is told the URL.
    await waitFor(async () => ((await view(a, token)).status.state === 'up' ? true : undefined), { what: 'up', timeoutMs: 10_000 });
    const hit = await waitFor(() => hits.find((h) => h.kind === 'hopper.reachable'), { what: 'the announce', timeoutMs: 15_000 });
    expect(hit).toMatchObject({ url: `https://${CF_HOST}` });

    // Through the tunnel (from the agent, the domain as Host): the API only, with a session; the UI is 404.
    expect((await rawRequest(a.url, { path: '/api/state', headers: { host: CF_HOST } })).status).toBe(401);
    expect((await rawRequest(a.url, { path: '/', headers: { host: CF_HOST } })).status).toBe(404);

    // Each change is an event, no credential or token in any: turned on, then the tunnel its mint saga made (issue #1609).
    const events = await a.events('types=remote_access.changed');
    expect(events.map((e) => e.data)).toEqual([
      expect.objectContaining({ from: { enabled: false }, to: { enabled: true, provider: 'cloudflare' }, credential: 'set' }),
      expect.objectContaining({ from: { enabled: true, provider: 'cloudflare' }, to: expect.objectContaining({ enabled: true, provider: 'cloudflare', provisioned: expect.objectContaining({ tunnelId: 'tun1' }) }) }),
    ]);
    expect(JSON.stringify(await a.events())).not.toMatch(new RegExp(`${CF}|cf-tunnel-token`));

    // Off: the tunnel and its DNS record are removed; the service is told nothing; the domain is any other Host again.
    const off = await post(a, token, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, status: { state: 'off' }, credentials: { cloudflare: expect.any(Object) } });
    expect(off.body.provisioned).toBeUndefined();
    expect(cf.tunnels.size).toBe(0);
    expect(cf.records.size).toBe(0);
    expect((await ask(a, { agent: 'cloudflared' })).status).toBe(204);
    expect((await rawRequest(a.url, { path: '/api/state', headers: { host: CF_HOST } })).status).toBe(421);
    // On again: a new tunnel, with the credential kept.
    expect((await post(a, token, { enabled: true })).body.provisioned).toMatchObject({ domain: CF_HOST });
    expect(cf.tunnels.size).toBe(1);
  }, 40_000);

  it('switching to ngrok removes Cloudflare\'s tunnel and mints ngrok\'s authtoken at the account\'s domain', async () => {
    const { a, cf, ng } = await boot();
    const token = await a.login();
    await post(a, token, { provider: 'cloudflare', credential: CF, enabled: true });
    const switched = await post(a, token, { provider: 'ngrok', credential: NG });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ enabled: true, provider: 'ngrok', provisioned: { provider: 'ngrok', domain: NG_HOST }, credentials: { cloudflare: expect.any(Object), ngrok: { last4: NG.slice(-4) } } });
    expect(cf.tunnels.size).toBe(0);
    expect(cf.records.size).toBe(0);
    const minted = [...ng.credentials.values()];
    expect(minted).toHaveLength(1);
    expect((await ask(a, { report: 'running' })).text).toBe(`url=https://${NG_HOST}\nauthtoken=${minted[0]}\n`);
    expect((await ask(a, { agent: 'cloudflared' })).status).toBe(204);
    // Off: the authtoken is revoked; the account's own domain stays.
    await post(a, token, { enabled: false });
    expect(ng.credentials.size).toBe(0);
    expect([...ng.domains.values()]).toEqual([NG_HOST]);
  });

  it('is not turned on without a provider and its credential; a provider\'s refusal leaves it off, nothing minted', async () => {
    const { a, cf } = await boot();
    const token = await a.login();
    const p = (body: unknown) => post(a, token, body);
    expect((await p({ enabled: true })).body.error).toMatch(/pick a provider first/);
    expect((await p({ credential: CF })).body.error).toMatch(/pick a provider first/);
    expect((await p({ provider: 'other' })).status).toBe(400);
    expect((await p({ provider: 'cloudflare', credential: 'short' })).status).toBe(400);
    expect((await p({ provider: 'cloudflare', enabled: true })).body.error).toMatch(/needs its API token first.*dash\.cloudflare\.com/);
    expect((await view(a, token)).enabled).toBe(false);
    expect((await p({ domain: 'not a domain' })).status).toBe(400);
    expect((await p({})).status).toBe(400);
    expect((await p({ other: 1 })).status).toBe(400);
    expect((await p({ restart: true })).body.error).toMatch(/remote access is off/);

    // A token Cloudflare refuses: 502, with why; still off, and nothing left at Cloudflare.
    const refused = await p({ provider: 'cloudflare', credential: 'x'.repeat(40), enabled: true });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/Cloudflare Tunnel did not mint the tunnel: Cloudflare refused the API token/);
    expect(await view(a, token)).toMatchObject({ enabled: false, provider: 'cloudflare' });
    expect(cf.tunnels.size).toBe(0);

    // A host name in no zone of the token's: 502 too.
    expect((await p({ credential: CF, domain: 'h.other.org', enabled: true })).body.error).toMatch(/in no zone the API token sees/);
    // On; the credential the tunnel runs on is not removed while on.
    expect((await p({ domain: null, enabled: true })).status).toBe(200);
    expect((await p({ credential: null })).body.error).toMatch(/turn remote access off to remove it/);
    expect((await p({ enabled: false, credential: null })).status).toBe(200);
    expect((await view(a, token)).credentials).toEqual({});
    // Only the hopper's admin: no session, no change.
    expect((await a.ui('/ui/api/remote-access', { enabled: false })).status).toBe(403);
  });

  it('names what a release cannot remove, and is off all the same', async () => {
    const { a, cf } = await boot();
    const token = await a.login();
    await post(a, token, { provider: 'cloudflare', credential: CF, enabled: true });
    await cf.close();
    const off = await post(a, token, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.leftover).toEqual([
      expect.stringMatching(/^the DNS record hopper\.example\.com .*does not answer/),
      expect.stringMatching(/^the connections of the tunnel tun1 .*does not answer/),
      expect.stringMatching(/^the tunnel tun1 .*does not answer/),
    ]);
    fakes.splice(fakes.indexOf(cf), 1);
  });

  it('answers the token only to its tunnel service\'s key, never through the tunnel, and not at all without a tunnel service', async () => {
    const { a } = await boot();
    const token = await a.login();
    await post(a, token, { provider: 'ngrok', credential: NG, enabled: true });
    expect((await ask(a, { key: '' })).status).toBe(401);
    expect((await ask(a, { key: 'x'.repeat(64) })).status).toBe(401);
    // Through the tunnel the Host is the domain: refused, whatever the key.
    expect((await ask(a, { host: NG_HOST })).status).toBe(404);
    expect((await ask(a)).status).toBe(200);
    // A restart is new settings to the tunnel service: it starts the agent again.
    const before = (await ask(a)).text;
    const restarted = await post(a, token, { restart: true });
    expect(restarted.body.restartedAt).toEqual(expect.any(String));
    expect((await ask(a)).text).toBe(`${before}restart=${restarted.body.restartedAt}\n`);
    await t!.stop();
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const plain = t;
    expect((await ask(plain)).status).toBe(404);
    expect((await view(plain, await plain.login())).service).toBe(false);
  });

  it('says what ngrok refused, from the tunnel service\'s report, and that no tunnel service asks', async () => {
    const { a } = await boot({ env: { HOPPER_TUNNEL_API: 'http://127.0.0.1:1' } });
    const token = await a.login();
    await post(a, token, { provider: 'ngrok', credential: NG, enabled: true });
    expect((await view(a, token)).status).toMatchObject({ state: 'no-service', error: expect.stringMatching(/tunnel service has not asked/) });
    await ask(a, { report: 'ERR_NGROK_105' });
    expect((await view(a, token)).status).toMatchObject({ state: 'down', error: expect.stringMatching(/refused the authtoken.*ERR_NGROK_105/) });
    // A restart is tried afresh.
    await post(a, token, { restart: true });
    await ask(a, { report: 'running' });
    expect((await view(a, token)).status.error).not.toMatch(/ERR_NGROK/);
    // A report that is not one is not kept.
    await ask(a, { report: 'rm%20-rf' });
    expect((await view(a, token)).status.error).not.toMatch(/rm/);
  });

  it('moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL of an install from before into the settings, once; off keeps them', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const DOMAIN = 'h.example.ngrok.app';
    const { a } = await boot({ dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: `https://${DOMAIN}` }, secrets: { NGROK_AUTHTOKEN: HAND } });
    const token = await a.login();
    expect(await view(a, token)).toMatchObject({ enabled: true, provider: 'ngrok', provisioned: { provider: 'ngrok', domain: DOMAIN } });
    expect((await ask(a)).text).toBe(`url=https://${DOMAIN}\nauthtoken=${HAND}\n`);
    // Off: the hopper minted none of it, so it keeps it; on again needs no API key.
    await post(a, token, { enabled: false });
    expect((await post(a, token, { enabled: true })).status).toBe(200);
    expect((await ask(a)).text).toBe(`url=https://${DOMAIN}\nauthtoken=${HAND}\n`);
    await post(a, token, { enabled: false });
    await a.stop();
    t = undefined;
    // A start with the variable still set does not turn it on again.
    const again = await boot({ dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: `https://${DOMAIN}` }, secrets: { NGROK_AUTHTOKEN: HAND } });
    expect((await view(again.a, await again.a.login())).enabled).toBe(false);
  });
});
