// The tunnel watch (issue #795): the hopper asks the tunnel agent's local API whether the endpoint for HOPPER_PUBLIC_URL
// is up. Up: the public URL is where the hopper is reached. Anything else — no agent, an error, no endpoint, an endpoint at
// another URL — is down. It only reads: the Host guard never takes a URL the agent reports. A loopback fake agent.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { watchTunnel, type TunnelWatch } from '../../src/http/tunnel.ts';
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
    watch = watchTunnel({ api: undefined, publicUrl: 'https://h.example', logger: logger() });
    expect(watch.url()).toBeUndefined();
  });

  it('is up when the agent has an endpoint at HOPPER_PUBLIC_URL, and asks GET /api/tunnels', async () => {
    const a = await agent(() => tunnels('https://h.example'));
    const log = logger();
    watch = watchTunnel({ api: a.api, publicUrl: 'https://h.example', logger: log, everyMs: 20 });
    await waitFor(() => watch!.url() === 'https://h.example', { what: 'up' });
    expect(a.asked[0]).toBe('GET /api/tunnels');
    expect(log.lines).toContain('info hopper: the tunnel is up: https://h.example');
  });

  it('is down when the endpoint is at another URL: the Host guard would refuse it', async () => {
    const a = await agent(() => tunnels('https://random-1234.ngrok-free.app'));
    const log = logger();
    watch = watchTunnel({ api: a.api, publicUrl: 'https://h.example', logger: log, everyMs: 20 });
    await waitFor(() => log.lines.some((l) => l.startsWith('warn')), { what: 'a warning' });
    expect(watch.url()).toBeUndefined();
    expect(log.lines.find((l) => l.startsWith('warn'))).toMatch(/not HOPPER_PUBLIC_URL \(https:\/\/h\.example\): https:\/\/random-1234\.ngrok-free\.app/);
  });

  it('goes down when the agent errs or has no endpoint, and up again when it is back; each change logged once', async () => {
    let answer: { status: number; body: unknown } = tunnels('https://h.example');
    const a = await agent(() => answer);
    const log = logger();
    watch = watchTunnel({ api: a.api, publicUrl: 'https://h.example', logger: log, everyMs: 20 });
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

  it('is down when no agent answers', async () => {
    const log = logger();
    watch = watchTunnel({ api: 'http://127.0.0.1:1', publicUrl: 'https://h.example', logger: log, everyMs: 20 });
    await waitFor(() => log.lines.some((l) => l.startsWith('warn')), { what: 'a warning' });
    expect(watch.url()).toBeUndefined();
  });
});
