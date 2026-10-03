// Read routes over engine state, plus the two settings the API may change: Jev mode, fake usage.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Clock, Store } from '../domain/ports.ts';
import { EVENT_TYPES } from '../domain/types.ts';
import type { DomainEvent, EventType } from '../domain/types.ts';
import type { Engine } from '../engine/index.ts';
import { HttpError, parseWith } from './errors.ts';

export const eventTypeList = z.string().optional().transform((s, ctx) => {
  if (!s) return undefined;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(EVENT_TYPES as readonly string[]).includes(p)) ctx.addIssue({ code: 'custom', message: `unknown event type ${p}` });
  }
  return parts as EventType[];
});

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
  types: eventTypeList,
});

const PAGE = 1000;

/** Events after `after`, oldest first, filtered by type; walks the log in pages. */
function eventsAfter(store: Store, after: number, limit: number, types?: EventType[]): DomainEvent[] {
  if (!types) return store.events.since(after, limit);
  const out: DomainEvent[] = [];
  let cursor = after;
  for (;;) {
    const page = store.events.since(cursor, PAGE);
    for (const e of page) if (types.includes(e.type) && out.length < limit) out.push(e);
    if (out.length >= limit || page.length < PAGE) return out;
    cursor = page[page.length - 1]!.seq;
  }
}

export function stateRoutes(app: FastifyInstance, o: { engine: Engine; store: Store; clock: Clock; version: string }): void {
  const { engine, store } = o;
  const startedAt = o.clock.now().getTime();
  const jev = () => ({ mode: engine.jevMode(), advisor: engine.advisorName });

  app.get('/api/health', async () => ({
    ok: true, version: o.version, jevMode: engine.jevMode(), advisor: engine.advisorName,
    uptimeS: Math.floor((o.clock.now().getTime() - startedAt) / 1000),
  }));
  app.get('/api/queue', async () => engine.getQueue());
  app.get('/api/machines', async () => ({ machines: await engine.getMachines() }));

  app.get('/api/decisions', async (req) => {
    const { limit } = parseWith(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50) }), req.query);
    return { decisions: store.decisions.list(limit) };
  });
  app.get('/api/decisions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const d = store.decisions.get(id);
    if (!d) throw new HttpError(404, `decision ${id} not found`);
    return d;
  });

  // Without `after`, the newest `limit` events (oldest first) — what a fresh UI wants.
  app.get('/api/events', async (req) => {
    const q = parseWith(eventsQuery, req.query);
    if (q.after === undefined) return { events: store.events.recent(q.limit, q.types).reverse() };
    return { events: eventsAfter(store, q.after, q.limit, q.types) };
  });

  app.get('/api/jev', async () => jev());
  app.put('/api/jev', async (req) => {
    const { mode } = parseWith(z.object({ mode: z.enum(['shadow', 'active']) }), req.body);
    engine.setJevMode(mode);
    return jev();
  });

  app.get('/api/usage', async () => ({ readings: await engine.getUsage() }));
  app.put('/api/usage/fake', async (req) => {
    const r = parseWith(z.object({
      used: z.number().finite().min(0),
      limit: z.number().finite(),
      unit: z.string().min(1).default('%'),
      machineId: z.string().min(1).optional(),
    }), req.body);
    return { readings: engine.setFakeUsage(r) };
  });
}
