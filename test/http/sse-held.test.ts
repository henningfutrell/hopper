// Issue #1383: the event stream never holds the event loop or the memory for a reader. A replay reads its pages with the
// loop free between them, and a stream whose reader does not read is ended once it is `behindBytes` behind, so its
// unread events are not kept in memory; its EventSource comes back with Last-Event-ID and is replayed. Fakes at the
// tenant parts; a real server on loopback, and a reader that does not read.
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { sseRoutes } from '../../src/http/sse.ts';
import type { TenantParts } from '../../src/http/tenants.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { waitFor } from '../support/wait.ts';

const apps: FastifyInstance[] = [];
const clients: ClientRequest[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const a of apps.splice(0)) await a.close();
});

const event = (seq: number, size = 10): DomainEvent => ({ seq, type: 'job.progress', at: '2026-10-15T10:00:00.000Z', data: { note: 'x'.repeat(size) } } as unknown as DomainEvent);

/** The tenant parts the stream uses: an event log of `count` events, live events through `emit`. */
function tenant(count: number, size = 10) {
  const listeners = new Set<(e: DomainEvent) => void>();
  const log = { pages: 0, unsubscribed: 0, between: [] as boolean[] };
  let freed = false;
  const none = () => () => undefined;
  const parts = {
    store: {
      events: {
        subscribe: (f: (e: DomainEvent) => void) => { listeners.add(f); return () => { listeners.delete(f); log.unsubscribed++; }; },
        since: (after: number, limit: number) => {
          if (log.pages > 0) log.between.push(freed);
          freed = false;
          setImmediate(() => { freed = true; });
          log.pages++;
          const out: DomainEvent[] = [];
          for (let s = after + 1; s <= Math.min(count, after + limit); s++) out.push(event(s, size));
          return out;
        },
      },
    },
    dispatcher: { onDeliveryUpdated: none },
    registry: { onStatus: none },
    usageHistory: { onRecorded: none },
    machineHistory: { onRecorded: none },
  } as unknown as TenantParts;
  return { parts, log, emit: (e: DomainEvent) => { for (const f of listeners) f(e); } };
}

async function serve(parts: TenantParts, behindBytes?: number): Promise<number> {
  const app = Fastify();
  apps.push(app);
  sseRoutes(app, { tenant: () => parts, instanceTag: 'test', ...(behindBytes ? { behindBytes } : {}) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

/** Opens the stream; the answer is paused: nothing of it is read. */
function open(port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const c = request({ host: '127.0.0.1', port, path }, (res) => { res.pause(); resolve(res); });
    c.on('error', reject);
    clients.push(c);
    c.end();
  });
}

describe('the event stream holds neither the loop nor the memory for a reader (issue #1383)', () => {
  it('a replay reads its pages with the event loop free between them', async () => {
    const t = tenant(3500);
    const port = await serve(t.parts);
    const res = await open(port, '/api/events/stream?after=0');
    res.resume();
    await waitFor(() => t.log.pages >= 4, { what: 'the replay to read every page' });
    expect(t.log.between).toEqual([true, true, true]);
  });

  it('gives a slow reader a long replay whole, a page at a time, and a live event after it', async () => {
    const t = tenant(3000, 1024);
    const port = await serve(t.parts, 64 * 1024);
    const res = await open(port, '/api/events/stream?after=0');
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (b: string) => { text += b; });
    t.emit(event(3001));
    await new Promise((r) => setTimeout(r, 100));
    res.resume();
    await waitFor(() => text.includes('id: 3001\n'), { what: 'the live event' });
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(Array.from({ length: 3001 }, (_, i) => i + 1));
    expect(t.log.unsubscribed).toBe(0);
  });

  it('ends a stream whose reader is far behind, and keeps no more of it', async () => {
    const t = tenant(0);
    const port = await serve(t.parts, 64 * 1024);
    const res = await open(port, '/api/events/stream');
    let ended = false;
    res.on('close', () => { ended = true; });
    res.socket.on('close', () => { ended = true; });
    // Far more than the socket's buffers take: the rest waits in the hopper's memory unless the stream ends.
    for (let s = 1; s <= 400 && t.log.unsubscribed === 0; s++) {
      t.emit(event(s, 100 * 1024));
      await new Promise((r) => setImmediate(r));
    }
    await waitFor(() => t.log.unsubscribed === 1, { what: 'the stream to end' });
    await waitFor(() => ended, { what: 'the reader to see it end' });
  });

  it('keeps a stream whose reader reads', async () => {
    const t = tenant(0);
    const port = await serve(t.parts, 64 * 1024);
    const res = await open(port, '/api/events/stream');
    let read = 0;
    res.on('data', (b: Buffer) => { read += b.length; });
    res.resume();
    for (let s = 1; s <= 40; s++) {
      t.emit(event(s, 10 * 1024));
      await waitFor(() => read >= s * 10 * 1024, { what: 'the reader to read the event' });
    }
    expect(t.log.unsubscribed).toBe(0);
  });
});
