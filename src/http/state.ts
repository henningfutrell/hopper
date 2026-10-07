// Read routes over engine state. Nothing here changes anything.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, PluginsView, UserStore } from '../domain/ports.ts';
import { userIdOf, type TenantParts } from './tenants.ts';
import { EVENT_TYPES } from '../domain/types.ts';
import type { DomainEvent, EventType } from '../domain/types.ts';
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
function eventsAfter(store: UserStore, after: number, limit: number, types?: EventType[]): DomainEvent[] {
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

/** GET /api/router: the router's status. */
export function routerView(plugins: PluginsView) {
  const s = plugins.routerStatus();
  return { router: s.name, plugin: s.plugin, fallback: s.fallback, ...(s.reason === undefined ? {} : { reason: s.reason }) };
}

/** The request's user's engine state (issue #158); `/api/health`'s version and uptime are the instance's. */
export function stateRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock; version: string; port: () => number }): void {
  const startedAt = o.clock.now().getTime();

  // A request with no user (loopback without a session, several users: issue #221) reads the instance's
  // health only — install.sh and self-update probe it — never a user's router or executors.
  app.get('/api/health', async (req) => {
    const uptimeS = Math.floor((o.clock.now().getTime() - startedAt) / 1000);
    if (userIdOf(req) === undefined) return { ok: true, version: o.version, uptimeS };
    const { engine, plugins } = o.tenant(req);
    const r = plugins.routerStatus();
    return { ok: true, version: o.version, router: r.name, fallback: r.fallback, executors: engine.executorNames, uptimeS };
  });
  app.get('/api/queue', async (req) => o.tenant(req).engine.getQueue());
  app.get('/api/machines', async (req) => ({ machines: await o.tenant(req).engine.getMachines() }));
  // What the Machines view edits (issue #18): the machine source, the attached machines, the detected ssh targets, the file version.
  app.get('/api/machines/config', async (req) => ({ ...(await o.tenant(req).plugins.machinesConfig()), port: o.port() }));

  app.get('/api/decisions', async (req) => {
    const { limit } = parseWith(decisionsQuery, req.query);
    return { decisions: o.tenant(req).store.decisions.list(limit) };
  });
  app.get('/api/decisions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const d = o.tenant(req).store.decisions.get(id);
    if (!d) throw new HttpError(404, `decision ${id} not found`);
    return d;
  });

  // Without `after`, the newest `limit` events (oldest first) — what a fresh UI wants.
  app.get('/api/events', async (req) => {
    const q = parseWith(eventsQuery, req.query);
    const { store } = o.tenant(req);
    if (q.after === undefined) return { events: store.events.recent(q.limit, q.types).reverse() };
    return { events: eventsAfter(store, q.after, q.limit, q.types) };
  });

  app.get('/api/router', async (req) => routerView(o.tenant(req).plugins));
  app.get('/api/plugins', async (req) => o.tenant(req).plugins.report());
  app.get('/api/routing', async (req) => o.tenant(req).plugins.routing());

  app.get('/api/usage', async (req) => o.tenant(req).engine.getUsageReport());
}
