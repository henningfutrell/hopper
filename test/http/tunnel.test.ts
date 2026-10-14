// The tunnel watch (issues #795, #880): the hopper asks the tunnel agent's local API whether the endpoint for the remote
// access URL is up. Up: that URL is where the hopper is reached. Anything else — no agent, an error, no endpoint, an
// endpoint at another URL — is down, with why. Remote access off: nothing asked. It only reads: the Host guard never takes
// a URL the agent reports. A loopback fake agent.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { installTunnelEdge, tunnelCaller, watchTunnel, type TunnelWatch } from '../../src/http/tunnel.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
let watch: TunnelWatch | undefined;
afterEach(async () => {
  await watch?.stop();
  watch = undefined;
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

/** A fake ngrok agent API: GET /api/tunnels answers `answer()`. */
async function agent(answer: () => { status: number; body: unknown }): Promise<{ api: string; asked: string[] }> {
  const asked: string[] = [];
  server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const a = answer();
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked };
}

const tunnels = (...urls: string[]) => ({ status: 200, body: { tunnels: urls.map((u, i) => ({ name: `t${i}`, public_url: u, proto: 'https', config: { addr: 'http://hopper:4790' } })), uri: '/api/tunnels' } });
const logger = () => {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`) };
};

describe('the tunnel watch', () => {
  it('has no URL and asks nothing when no tunnel API is set', async () => {
    watch = watchTunnel({ apis: {}, target: () => ({ provider: 'ngrok', url: 'https://h.example' }), logger: logger() });
    expect(watch.url()).toBeUndefined();
    expect(watch.reason()).toBeUndefined();
  });

  it('is up when the agent has an endpoint at the remote access URL, and asks GET /api/tunnels', async () => {
    const a = await agent(() => tunnels('https://h.example'));
    const log = logger();
    watch = watchTunnel({ apis: { ngrok: a.api }, target: () => ({ provider: 'ngrok', url: 'https://h.example' }), logger: log, everyMs: 20 });
    await waitFor(() => watch!.url() === 'https://h.example', { what: 'up' });
    expect(a.asked[0]).toBe('GET /api/tunnels');
    expect(log.lines).toContain('info hopper: the tunnel is up: https://h.example');
  });

  it('is down when the endpoint is at another URL: the Host guard would refuse it', async () => {
    const a = await agent(() => tunnels('https://random-1234.ngrok-free.app'));
    const log = logger();
    watch = watchTunnel({ apis: { ngrok: a.api }, target: () => ({ provider: 'ngrok', url: 'https://h.example' }), logger: log, everyMs: 20 });
    await waitFor(() => log.lines.some((l) => l.startsWith('warn')), { what: 'a warning' });
    expect(watch.url()).toBeUndefined();
    expect(log.lines.find((l) => l.startsWith('warn'))).toMatch(/not the remote access URL \(https:\/\/h\.example\): https:\/\/random-1234\.ngrok-free\.app/);
  });

  it('goes down when the agent errs or has no endpoint, and up again when it is back; each change logged once', async () => {
    let answer: { status: number; body: unknown } = tunnels('https://h.example');
    const a = await agent(() => answer);
    const log = logger();
    watch = watchTunnel({ apis: { ngrok: a.api }, target: () => ({ provider: 'ngrok', url: 'https://h.example' }), logger: log, everyMs: 20 });
    await waitFor(() => watch!.url() !== undefined, { what: 'up' });
    answer = { status: 502, body: { error: 'no session' } };
    await waitFor(() => watch!.url() === undefined, { what: 'down' });
    answer = tunnels();
    await waitFor(() => a.asked.length > 6, { what: 'more asks' });
    expect(watch.url()).toBeUndefined();
    answer = tunnels('https://h.example');
    await waitFor(() => watch!.url() === 'https://h.example', { what: 'up again' });
    expect(log.lines.filter((l) => l.includes('is up'))).toHaveLength(2);
  });

  it('asks nothing while remote access is off, and follows its URL when it is turned on or changed', async () => {
    const a = await agent(() => tunnels('https://h.example'));
    let url: string | undefined;
    watch = watchTunnel({ apis: { ngrok: a.api }, target: () => (url === undefined ? undefined : { provider: 'ngrok', url }), logger: logger(), everyMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.asked).toEqual([]);
    expect(watch.url()).toBeUndefined();
    expect(watch.reason()).toBeUndefined();
    url = 'https://h.example';
    await waitFor(() => watch!.url() === 'https://h.example', { what: 'up' });
    url = 'https://other.example';
    // Not up a moment longer on a changed URL; why, at the next ask.
    expect(watch.url()).toBeUndefined();
    await waitFor(() => /not the remote access URL \(https:\/\/other\.example\)/.test(watch!.reason() ?? ''), { what: 'down on the new URL' });
    url = undefined;
    await waitFor(() => watch!.reason() === undefined, { what: 'off' });
    expect(watch.url()).toBeUndefined();
  });

  it('is down when no agent answers', async () => {
    const log = logger();
    watch = watchTunnel({ apis: { ngrok: 'http://127.0.0.1:1' }, target: () => ({ provider: 'ngrok', url: 'https://h.example' }), logger: log, everyMs: 20 });
    await waitFor(() => log.lines.some((l) => l.startsWith('warn')), { what: 'a warning' });
    expect(watch.url()).toBeUndefined();
    expect(watch.reason()).toMatch(/does not answer/);
  });
});

describe('tunnelCaller: who a request counts as for the sign-in limit', () => {
  const caller = tunnelCaller({ agentOf: (peer) => (peer === '10.89.1.2' ? 'ngrok' : peer === '10.89.1.3' ? 'cloudflare' : undefined) });
  const req = (ip: string, named?: string | string[]) => ({ ip, headers: named === undefined ? {} : { 'x-hopper-caller': named } });

  it('from the tunnel agent: the address its edge names', () => {
    expect(caller(req('10.89.1.2', '203.0.113.5'))).toBe('203.0.113.5');
    expect(caller(req('10.89.1.2', ' 2001:db8::1 '))).toBe('2001:db8::1');
    expect(caller(req('10.89.1.2', '::ffff:203.0.113.5'))).toBe('203.0.113.5');
  });

  it('from the tunnel agent with no single address named: the agent\'s own address', () => {
    for (const named of [undefined, '', 'h.example', '203.0.113.5, 198.51.100.7', ['203.0.113.5', '198.51.100.7']]) {
      expect(caller(req('10.89.1.2', named))).toBe('10.89.1.2');
    }
  });

  it('from the cloudflared agent: the address Cloudflare names in cf-connecting-ip, never x-hopper-caller (issue #968)', () => {
    expect(caller({ ip: '10.89.1.3', headers: { 'cf-connecting-ip': '203.0.113.9' } })).toBe('203.0.113.9');
    expect(caller({ ip: '10.89.1.3', headers: { 'x-hopper-caller': '203.0.113.9' } })).toBe('10.89.1.3');
    expect(caller({ ip: '10.89.1.2', headers: { 'cf-connecting-ip': '203.0.113.9' } })).toBe('10.89.1.2');
  });

  it('from any other peer: its own address, whatever it names', () => {
    expect(caller(req('192.168.1.9', '203.0.113.5'))).toBe('192.168.1.9');
  });
});

describe('cloudflared (issue #968): up while its local API says it is ready', () => {
  it('asks GET /ready of the cloudflared agent, never ngrok\'s, and names each agent\'s address', async () => {
    let ready = 503;
    const a = await agent(() => ({ status: ready, body: { status: ready, readyConnections: ready === 200 ? 4 : 0 } }));
    const log = logger();
    watch = watchTunnel({ apis: { ngrok: 'http://127.0.0.1:1', cloudflare: a.api }, target: () => ({ provider: 'cloudflare', url: 'https://h.example.com' }), logger: log, everyMs: 20 });
    await waitFor(() => /no connection to Cloudflare yet \(HTTP 503\)/.test(watch!.reason() ?? ''), { what: 'down' });
    ready = 200;
    await waitFor(() => watch!.url() === 'https://h.example.com', { what: 'up' });
    expect(new Set(a.asked)).toEqual(new Set(['GET /ready']));
    // Both hosts are 127.0.0.1 here: an address is one agent's, the last one listed.
    expect(watch.agentOf('127.0.0.1')).toBe('cloudflare');
    expect(watch.agentOf('192.0.2.1')).toBeUndefined();
  });

  it('is down, with why, when the provider picked has no agent API set', async () => {
    watch = watchTunnel({ apis: { ngrok: 'http://127.0.0.1:1' }, target: () => ({ provider: 'cloudflare', url: 'https://h.example.com' }), logger: logger(), everyMs: 20 });
    await waitFor(() => /HOPPER_CLOUDFLARED_API is not set/.test(watch!.reason() ?? ''), { what: 'down' });
  });
});

describe('the tunnel\'s edge in the hopper (issues #795, #968): only the API, and a limit per caller', () => {
  async function app(agent: 'ngrok' | 'cloudflare' | undefined) {
    let t = 0;
    const a = Fastify();
    installTunnelEdge(a, { tunnel: { agentOf: () => agent }, domain: () => 'h.example.com', now: () => t });
    a.all('/*', async () => ({ ok: true }));
    await a.ready();
    const hit = async (url: string, caller = '203.0.113.5', host = 'h.example.com') => (await a.inject({ url, headers: { host, 'cf-connecting-ip': caller } })).statusCode;
    return { a, hit, later: () => { t += 60_000; } };
  }

  it('through the tunnel: 404 off the API, the event stream included; the agent\'s own ask names the hopper as Host and passes', async () => {
    const { a, hit } = await app('cloudflare');
    for (const p of ['/api/state', '/ui/api/jobs', '/ui/auth/api-token', '/ui/auth/token/refresh']) expect(await hit(p), p).toBe(200);
    expect(await hit('/tunnel/agent', '203.0.113.5', 'hopper:4790')).toBe(200);
    expect(await hit('/tunnel/agent', '203.0.113.5', 'H.example.com:443')).toBe(404);
    for (const p of ['/', '/index.html', '/api/events/stream?token=x', '/ui/auth/login', '/help/x', '/install.sh', '/artifact-link/x']) expect(await hit(p), p).toBe(404);
    await a.close();
  });

  it('120 requests a minute per caller, 5 token exchanges; each caller its own count, new after a minute', async () => {
    const { a, hit, later } = await app('cloudflare');
    for (let i = 0; i < 5; i++) expect(await hit('/ui/auth/api-token')).toBe(200);
    expect(await hit('/ui/auth/api-token')).toBe(429);
    for (let i = 0; i < 114; i++) expect(await hit('/api/state')).toBe(200);
    expect(await hit('/api/state')).toBe(429);
    expect(await hit('/api/state', '198.51.100.7')).toBe(200);
    later();
    expect(await hit('/api/state')).toBe(200);
    await a.close();
  });

  it('from any other peer: nothing changes', async () => {
    const { a, hit } = await app(undefined);
    expect(await hit('/')).toBe(200);
    for (let i = 0; i < 130; i++) await hit('/api/state');
    expect(await hit('/api/state')).toBe(200);
    await a.close();
  });
});
