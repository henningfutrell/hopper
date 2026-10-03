// GET /api/events/stream (design.md "SSE"): replay after a seq, then live; delivery updates
// interleaved without an id; a comment ping every 15 s.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store, WebhookDispatcher } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';
import { parseWith } from './errors.ts';

const PING_MS = 15_000;
const REPLAY_PAGE = 1000;

const seq = z.coerce.number().int().min(0);

export function sseRoutes(app: FastifyInstance, o: { store: Store; dispatcher: WebhookDispatcher }): void {
  const open = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/events/stream', (req, reply) => {
    const q = parseWith(z.object({ after: seq.optional() }), req.query);
    const header = req.headers['last-event-id'];
    const after = q.after ?? (typeof header === 'string' && header !== '' ? parseWith(seq, header) : undefined);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    open.add(res);

    let lastSeq = after ?? 0;
    const send = (e: DomainEvent): void => {
      if (e.seq <= lastSeq) return; // replay and live may overlap: dedupe by seq
      lastSeq = e.seq;
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Subscribe first, then replay, so nothing appended in between is lost.
    const unsubscribe = o.store.events.subscribe(send);
    const offDelivery = o.dispatcher.onDeliveryUpdated((d) => {
      res.write(`event: delivery.updated\ndata: ${JSON.stringify(d)}\n\n`);
    });
    if (after !== undefined) {
      for (let page = o.store.events.since(lastSeq, REPLAY_PAGE); page.length > 0; page = o.store.events.since(lastSeq, REPLAY_PAGE)) {
        for (const e of page) send(e);
        if (page.length < REPLAY_PAGE) break;
      }
    }
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();

    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      offDelivery();
      open.delete(res);
    });
  });
}
