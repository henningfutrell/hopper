// Read routes over engine state. Nothing here changes anything (router mode is a UI mutation).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Clock, PluginsView, Store } from '../domain/ports.ts';
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

export const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
  types: eventTypeList,
});

export const decisionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50) });

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

/** GET /api/router and the UI's POST /ui/api/router-mode answer: mode plus the router's status. */
export function routerView(engine: Engine, plugins: PluginsView) {
  const s = plugins.routerStatus();
  return { mode: engine.routerMode(), router: s.name, plugin: s.plugin, fallback: s.fallback, ...(s.reason === undefined ? {} : { reason: s.reason }) };
}

export function stateRoutes(app: FastifyInstance, o: { engine: Engine; store: Store; clock: Clock; version: string; plugins: PluginsView }): void {
  const { engine, store, plugins } = o;
  const startedAt = o.clock.now().getTime();

  app.get('/api/health', async () => {
    const r = plugins.routerStatus();
    return {
      ok: true, version: o.version, routerMode: engine.routerMode(), router: r.name, fallback: r.fallback, executors: engine.executorNames,
      uptimeS: Math.floor((o.clock.now().getTime() - startedAt) / 1000),
    };
  });
  app.get('/api/queue', async () => engine.getQueue());
  app.get('/api/machines', async () => ({ machines: await engine.getMachines() }));
  // What the Machines view edits (issue #18): the machine source, the attached machines, the detected ssh targets, the file version.
  app.get('/api/machines/config', async () => plugins.machinesConfig());

  app.get('/api/decisions', async (req) => {
    const { limit } = parseWith(decisionsQuery, req.query);
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

  app.get('/api/router', async () => routerView(engine, plugins));
  app.get('/api/plugins', async () => plugins.report());
  app.get('/api/routing', async () => plugins.routing());

  app.get('/api/usage', async () => engine.getUsageReport());
}
