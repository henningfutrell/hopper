// GET /api/events/stream (design.md "SSE"): replay after a seq, then live; delivery updates, source status
// updates (`source.updated`) and new usage samples (`usage.recorded`, issue #502) interleaved without an id;
// a comment ping every 15 s.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantParts } from './tenants.ts';
import type { DomainEvent } from '../domain/types.ts';
import { parseWith } from './errors.ts';

const PING_MS = 15_000;
const REPLAY_PAGE = 1000;

const seq = z.coerce.number().int().min(0);
export const streamQuery = z.object({ after: seq.optional() });

/** The request's user's events, deliveries, source statuses and usage samples only (issue #158). */
export function sseRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  const open = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/events/stream', (req, reply) => {
    const q = parseWith(streamQuery, req.query);
    // An EventSource reconnects to the URL it opened, stale `after` included; Last-Event-ID is
    // where it actually is, so the header wins.
    const header = req.headers['last-event-id'];
    const after = (typeof header === 'string' && header !== '' ? parseWith(seq, header) : undefined) ?? q.after;
    const { store, dispatcher, registry, usageHistory } = o.tenant(req);

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
    const unsubscribe = store.events.subscribe(send);
    const offDelivery = dispatcher.onDeliveryUpdated((d) => {
      res.write(`event: delivery.updated\ndata: ${JSON.stringify(d)}\n\n`);
    });
    const offSource = registry.onStatus((st) => {
      res.write(`event: source.updated\ndata: ${JSON.stringify(st)}\n\n`);
    });
    const offUsage = usageHistory.onRecorded((added) => {
      res.write(`event: usage.recorded\ndata: ${JSON.stringify({ added })}\n\n`);
    });
    if (after !== undefined) {
      for (let page = store.events.since(lastSeq, REPLAY_PAGE); page.length > 0; page = store.events.since(lastSeq, REPLAY_PAGE)) {
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
      offSource();
      offUsage();
      open.delete(res);
    });
  });
}
