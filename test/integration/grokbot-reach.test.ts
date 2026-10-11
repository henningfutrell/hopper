// The tunnel tells Grok Bot where the hopper is (issue #795), through the real composition root: HOPPER_TUNNEL_API names
// a loopback fake of the ngrok agent's local API; once it has an endpoint at HOPPER_PUBLIC_URL, the user's Grok Bot
// routine gets `hopper.reachable` with that URL. A loopback receiver.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  cleanup?.();
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

describe('the tunnel and the Grok Bot routine', () => {
  it('announces HOPPER_PUBLIC_URL once the tunnel agent has an endpoint there', async () => {
    let up = false;
    const agent = await serve(() => JSON.stringify({ tunnels: up ? [{ public_url: 'https://h.example', proto: 'https' }] : [] }));
    const hits: Record<string, unknown>[] = [];
    const routine = await serve((_p, body) => { hits.push(JSON.parse(body) as Record<string, unknown>); return '{}'; });
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({
      dbPath: db.dbPath, env: { HOPPER_PUBLIC_URL: 'https://h.example', HOPPER_TUNNEL_API: agent },
      secrets: { GROKBOT_WEBHOOK_URL: `${routine}/routine`, GROKBOT_WEBHOOK_KEY: 'sekrit' }, seams: { grokbot: { baseMs: 20, watchMs: 20 } },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(hits.filter((h) => h.kind === 'hopper.reachable')).toEqual([]);
    up = true;
    const hit = await waitFor(() => hits.find((h) => h.kind === 'hopper.reachable'), { what: 'the announce', timeoutMs: 15_000 });
    expect(hit).toMatchObject({ source: 'hopper', url: 'https://h.example', apiTokenUrl: 'https://h.example/ui/auth/api-token' });
  }, 20_000);
});
