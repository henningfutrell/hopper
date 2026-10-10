// Issue #695: a job on a client target reaches the hopper through its client's door — a listener on loopback there
// that passes the job's `/job/` requests on to the hopper's URL as the client reaches it. The job needs no name
// resolved: the hopper's bare container name, which only its own network resolves, never reaches the job.
//
// Feature: the client door
//   Scenario: a job's request goes through the door to the hopper
//     Given a hopper the client reaches at its URL, and the client's door on loopback
//     When a job sends POST /job/github through the door
//     Then the hopper gets the method, the path, the headers and the body, with its own Host
//     And the job gets the hopper's status and body
//   Scenario: an answer that streams (the job stream, git) reaches the job as it comes
//   Scenario: anything but a /job/ request, or a Host that is not the door's own, is refused; nothing reaches the hopper
//   Scenario: a hopper the client cannot reach is said plainly, with its URL
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startDoor, type Door } from '../../src/client/door.ts';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

const servers: Server[] = [];
const doors: Door[] = [];
afterEach(async () => {
  for (const d of doors.splice(0)) await d.stop();
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});

/** A stand-in hopper on loopback: it records each request; `/job/stream` sends one event, then waits. */
async function hopper(): Promise<{ url: string; seen: Seen[]; release(): void }> {
  const seen: Seen[] = [];
  let release = (): void => undefined;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/job/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('id: 1\ndata: first\n\n');
        release = () => res.end('id: 2\ndata: last\n\n');
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-answer': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, seen, release: () => release() };
}

interface Answer { status: number; headers: IncomingHttpHeaders; body: string }

function send(url: string, o: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string; first?: (chunk: string) => void }): Promise<Answer> {
  const u = new URL(o.path, url);
  return new Promise((resolve, reject) => {
    const req = request(u, { method: o.method ?? 'GET', headers: { ...o.headers, ...(o.host ? { host: o.host } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (!body) o.first?.(c); body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

async function door(url: string): Promise<Door> {
  const d = await startDoor({ url });
  doors.push(d);
  return d;
}

describe('the client door (issue #695)', () => {
  it('listens on loopback only', async () => {
    const h = await hopper();
    const d = await door(h.url);
    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('passes a job\'s request on to the hopper with the hopper\'s Host, and the hopper\'s answer back', async () => {
    const h = await hopper();
    const d = await door(h.url);
    const a = await send(d.url, { method: 'POST', path: '/job/github?x=1', headers: { authorization: 'Bearer job-token', 'content-type': 'application/x-www-form-urlencoded' }, body: 'op=issue.view&number=1' });
    expect(a).toMatchObject({ status: 201, body: '{"ok":true}' });
    expect(a.headers['x-answer']).toBe('yes');
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({ method: 'POST', url: '/job/github?x=1', body: 'op=issue.view&number=1' });
    expect(h.seen[0]!.headers).toMatchObject({ host: new URL(h.url).host, authorization: 'Bearer job-token', 'content-type': 'application/x-www-form-urlencoded' });
  });

  it('passes a streamed answer on as it comes', async () => {
    const h = await hopper();
    const d = await door(h.url);
    let first = '';
    const a = send(d.url, { path: '/job/stream', headers: { accept: 'text/event-stream' }, first: (c) => { first = c; } });
    await expect.poll(() => first, { timeout: 5000 }).toContain('data: first');
    h.release();
    expect((await a).body).toBe('id: 1\ndata: first\n\nid: 2\ndata: last\n\n');
  });

  it('refuses a path outside /job/ and a Host that is not its own; nothing reaches the hopper', async () => {
    const h = await hopper();
    const d = await door(h.url);
    expect((await send(d.url, { path: '/api/health' })).status).toBe(404);
    expect((await send(d.url, { path: '/ui/api/vault', method: 'POST', body: '{}' })).status).toBe(404);
    expect((await send(d.url, { path: '/job/github', host: 'evil.example:80' })).status).toBe(421);
    expect(h.seen).toEqual([]);
  });

  it('says plainly when the hopper cannot be reached, with its URL', async () => {
    const h = await hopper();
    const gone = h.url;
    await new Promise((r) => { servers[0]!.close(r); });
    servers.splice(0);
    const d = await door(gone);
    const a = await send(d.url, { path: '/job/github' });
    expect(a.status).toBe(502);
    expect(a.body).toContain(`this machine cannot reach the hopper at ${gone}`);
  });
});
