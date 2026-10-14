// The sign-in limit counts each caller behind the tunnel (issue #795). The API-token exchange is a sign-in, so it has the
// sign-in limit too, and through the tunnel the edge's lower one (issue #968). Every request through the tunnel comes from one peer, the ngrok agent; its edge names the caller in
// `x-hopper-caller`. The hopper reads that header only from the peer that HOPPER_TUNNEL_API's host is, so a stranger
// cannot use up an agent's exchanges, and a LAN peer cannot step past the limit with a header. Real daemon, real HTTP
// server; the tunnel agent's local API is a loopback fake, so the tunnel's peer is loopback here.
//
// Feature: the sign-in limit behind the tunnel
//   Scenario: past 20 exchanges a minute from one address, an exchange is 429
//   Scenario: behind the tunnel, each caller has its own count
//   Scenario: with no tunnel, the header is not read
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const PUBLIC = 'https://h.example';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  cleanup?.();
});

/** A fake of the ngrok agent's local API, with an endpoint at the public URL; counts the asks. */
async function tunnelAgent(): Promise<{ url: string; asks: () => number }> {
  let asks = 0;
  const s = createServer((_req, res) => {
    asks++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tunnels: [{ public_url: PUBLIC, proto: 'https' }] }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, asks: () => asks };
}

async function boot(tunnel: boolean): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const agent = tunnel ? await tunnelAgent() : undefined;
  // With a tunnel: remote access on at the public URL's domain, from an install's NGROK_AUTHTOKEN (issue #880).
  t = await startTestApp({ dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: PUBLIC, ...(agent ? { HOPPER_TUNNEL_API: agent.url } : {}) }, ...(agent ? { secrets: { NGROK_AUTHTOKEN: 'a'.repeat(30) } } : {}) });
  if (agent) await waitFor(() => (agent.asks() > 0 ? true : undefined), { what: 'the tunnel watch', timeoutMs: 10_000 });
  return t;
}

/** An agent's exchange through the public URL, with an API token as its sign-in, which the door refuses: 401 until the limit. */
async function exchange(a: TestApp, caller?: string): Promise<number> {
  return (await rawRequest(a.url, {
    method: 'POST', path: '/ui/auth/api-token', body: '{}',
    headers: { host: 'h.example', authorization: `Bearer hopper_at_${'0'.repeat(64)}`, 'content-type': 'application/json', ...(caller ? { 'x-hopper-caller': caller } : {}) },
  })).status;
}

async function exchanges(a: TestApp, n: number, caller?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await exchange(a, caller));
  return out;
}

describe('the sign-in limit behind the tunnel (issue #795)', () => {
  it('past 20 exchanges a minute from one address, an exchange is 429', async () => {
    const a = await boot(false);
    const statuses = await exchanges(a, 21);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('behind the tunnel, each caller has its own count: the tunnel\'s edge, 5 exchanges a minute (issue #968)', async () => {
    const a = await boot(true);
    const stranger = await exchanges(a, 6, '203.0.113.5');
    expect(stranger.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(stranger[5]).toBe(429);
    expect(await exchange(a, '198.51.100.7')).toBe(401);
    // A request from the tunnel with no caller named is counted as the tunnel's own address: one count for all of them.
    expect((await exchanges(a, 6)).at(-1)).toBe(429);
  });

  it('with no tunnel, the header is not read', async () => {
    const a = await boot(false);
    await exchanges(a, 20, '203.0.113.5');
    expect(await exchange(a, '198.51.100.7')).toBe(429);
  });
});
