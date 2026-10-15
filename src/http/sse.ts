// GET /api/events/stream (design.md "SSE"): replay after a seq, then live; delivery updates, source status
// updates (`source.updated`), new usage samples (`usage.recorded`, issue #502) and new machine samples
// (`machine.recorded`, issue #560) interleaved without an id;
// a comment ping every 15 s. It opens with the hopper's tag (`hopper.instance`, issue #1295).
// Issue #1383: a replay frees the event loop between its pages, live events held back until it ends; a stream whose
// reader is BEHIND_BYTES behind is ended, so its unread events are not kept in memory. Its EventSource comes back with
// Last-Event-ID and is replayed from there.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantParts } from './tenants.ts';
import type { DomainEvent } from '../domain/types.ts';
import { parseWith } from './errors.ts';
import { INSTANCE_EVENT } from './instance-tag.ts';

const PING_MS = 15_000;
const REPLAY_PAGE = 1000;
/** A reader this far behind (bytes written and not yet taken by its socket) is ended. */
export const BEHIND_BYTES = 8 * 1024 ** 2;

const seq = z.coerce.number().int().min(0);
export const streamQuery = z.object({ after: seq.optional() });

/** The request's user's events, deliveries, source statuses and usage samples only (issue #158). */
export function sseRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; instanceTag: string; behindBytes?: number }): void {
  const open = new Set<ServerResponse>();
  const behindBytes = o.behindBytes ?? BEHIND_BYTES;
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/events/stream', (req, reply) => {
    const q = parseWith(streamQuery, req.query);
    // An EventSource reconnects to the URL it opened, stale `after` included; Last-Event-ID is
    // where it actually is, so the header wins.
    const header = req.headers['last-event-id'];
    const after = (typeof header === 'string' && header !== '' ? parseWith(seq, header) : undefined) ?? q.after;
    const { store, dispatcher, registry, usageHistory, machineHistory } = o.tenant(req);

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
    /**
     * Writes, unless the reader is too far behind: then the stream ends, and what it did not read goes with it. A replay
     * page is not checked (`paged`): it waits for the reader before the next, so it is never more than one page ahead.
     */
    const write = (text: string, paged = false): void => {
      if (res.destroyed) return;
      res.write(text);
      if (paged || res.writableLength <= behindBytes) return;
      console.warn(`hopper: ended an event stream whose reader fell ${Math.round(res.writableLength / 1024)} KiB behind; it comes back and is replayed`);
      res.destroy();
    };
    // First the hopper's tag (issue #1295): the page takes no event of this stream until it is its hopper's.
    write(`event: ${INSTANCE_EVENT}\ndata: ${JSON.stringify(o.instanceTag)}\n\n`);

    let lastSeq = after ?? 0;
    const send = (e: DomainEvent, paged = false): void => {
      if (e.seq <= lastSeq) return; // replay and live may overlap: dedupe by seq
      lastSeq = e.seq;
      write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`, paged);
    };
    // Live events wait while the replay runs, so none is sent before an older one.
    let held: DomainEvent[] | undefined = after === undefined ? undefined : [];
    // Subscribe first, then replay, so nothing appended in between is lost.
    const unsubscribe = store.events.subscribe((e) => { if (held) held.push(e); else send(e); });
    const offDelivery = dispatcher.onDeliveryUpdated((d) => {
      write(`event: delivery.updated\ndata: ${JSON.stringify(d)}\n\n`);
    });
    const offSource = registry.onStatus((st) => {
      write(`event: source.updated\ndata: ${JSON.stringify(st)}\n\n`);
    });
    const offUsage = usageHistory.onRecorded((added) => {
      write(`event: usage.recorded\ndata: ${JSON.stringify({ added })}\n\n`);
    });
    const offMachine = machineHistory.onRecorded((added) => {
      write(`event: machine.recorded\ndata: ${JSON.stringify({ added })}\n\n`);
    });
    if (held) {
      // One page a turn of the loop, the next once the reader took this one: a long replay never holds the loop, and a
      // slow reader never has more than a page waiting.
      const replay = (): void => {
        if (res.destroyed) return;
        const page = store.events.since(lastSeq, REPLAY_PAGE);
        for (const e of page) send(e, true);
        if (page.length === REPLAY_PAGE) {
          if (res.writableNeedDrain) res.once('drain', replay);
          else setImmediate(replay);
          return;
        }
        const live = held ?? [];
        held = undefined;
        for (const e of live) send(e);
      };
      replay();
    }
    const ping = setInterval(() => write(': ping\n\n'), PING_MS);
    ping.unref();

    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      offDelivery();
      offSource();
      offUsage();
      offMachine();
      open.delete(res);
    });
  });
}
