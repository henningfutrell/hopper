// Read routes over engine state. Nothing here changes anything.
import type { EventLoopStall } from './event-loop.ts';
import { strayChildren as processStrays, type StrayChildren } from './stray-children.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, PluginsView, UserStore } from '../domain/ports.ts';
import { userIdOf, type TenantParts } from './tenants.ts';
import type { Sandboxes } from '../sandbox/service.ts';
import { EVENT_TYPES } from '../domain/types.ts';
import type { DomainEvent, EventType } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';
import { pullRequestsView, yoloModeView } from './ui/yolo-mode.ts';
import { preemptionView } from './ui/preemption.ts';
import { threadAskView } from './ui/thread-ask.ts';
import { tldrView } from './ui/tldr.ts';

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
export function stateRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock; version: string; port: () => number; sandboxes: Pick<Sandboxes, 'view'>; stall?: () => EventLoopStall | undefined; strays?: () => StrayChildren | undefined }): void {
  const startedAt = o.clock.now().getTime();

  // A request with no user (loopback without a session, several users: issue #221) reads the instance's
  // health only — install.sh and self-update probe it — never a user's router or executors.
  app.get('/api/health', async (req) => {
    const uptimeS = Math.floor((o.clock.now().getTime() - startedAt) / 1000);
    // The last stall of the event loop (issue #1002), while it is shown: the instance's, like the uptime.
    // The hopper's zombie and orphaned child processes, when there are more than a few (issue #2623): the instance's too.
    const stall = o.stall?.(), strays = (o.strays ?? processStrays.problem)();
    const loop = { ...(stall ? { eventLoopStall: stall } : {}), ...(strays ? { strayChildren: strays } : {}) };
    if (userIdOf(req) === undefined) return { ok: true, version: o.version, uptimeS, ...loop };
    const { engine, plugins } = o.tenant(req);
    const r = plugins.routerStatus();
    return { ok: true, version: o.version, router: r.name, fallback: r.fallback, executors: engine.executorNames, parkingExecutors: engine.parkingExecutors, reviewingExecutors: engine.reviewingExecutors, uptimeS, ...loop };
  });
  app.get('/api/queue', async (req) => o.tenant(req).engine.getQueue());
  // Priority lanes (issue #535): the settings, the lanes chosen, every lane's reliability and why.
  app.get('/api/priority-lanes', async (req) => o.tenant(req).engine.priorityLanes.view());
  // Blast radius (issue #542): each machine's discovery, rating and gate, the actor machines, the settings.
  app.get('/api/blast-radius', async (req) => o.tenant(req).engine.blastRadius.view());
  // Phase shifts (issue #548): the default mode, what a parent does while its fork runs, the levels that may shift.
  app.get('/api/phase-shifts', async (req) => { const t = o.tenant(req); return t.engine.phaseShifts.view(t.levelNames()); });
  // Yolo mode (issue #579): whether jobs may merge their own pull requests, and the job repositories to set it per repository.
  app.get('/api/yolo-mode', async (req) => yoloModeView(o.tenant(req)));
  // Auto-park (issue #650): how long a question waits on a person before its job parks by itself.
  // Preemption (issue #1525): whether a higher-priority job takes a running job's lane, and the minimum run time.
  app.get('/api/preemption', async (req) => preemptionView(o.tenant(req)));
  app.get('/api/thread-ask', async (req) => threadAskView(o.tenant(req)));
  // The TL;DR (issue #569): whether a cheap model writes one for every long card, and the cards show it.
  app.get('/api/tldr', async (req) => tldrView(o.tenant(req)));
  // The Pull requests list (issue #637): the waiting pull requests, per repository, their state and yolo mode; where merging waits.
  app.get('/api/pull-requests', async (req) => pullRequestsView(o.tenant(req)));
  // The machines, the last report of the keep-alive loop on Windows on the Windows link (issue #712), when fresh, and the sandbox host (issue #2272), when set.
  app.get('/api/machines', async (req) => {
    const t = o.tenant(req);
    const windowsLink = t.windowsLink.reported(o.clock.now().toISOString()), sandboxHost = t.engine.sandboxHost.hosts();
    return { machines: await t.engine.getMachines(), ...(windowsLink ? { windowsLink } : {}), ...(sandboxHost.length ? { sandboxHost } : {}) };
  });
  // What the Machines view edits (issue #18): the machine source, the attached machines, the detected ssh targets, the file version.
  app.get('/api/machines/config', async (req) => ({ ...(await o.tenant(req).plugins.machinesConfig()), port: o.port() }));
  // The sandboxes the hopper starts (issue #1349): the user's latest sandbox runs, and the boxes it could not burn.
  app.get('/api/sandboxes', async (req) => {
    o.tenant(req);
    return o.sandboxes.view(userIdOf(req)!);
  });

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
  app.get('/api/lanes/plan', async (req) => o.tenant(req).engine.laneTuning.plan());
  app.get('/api/lanes/costs', async (req) => o.tenant(req).engine.laneTuning.costs());
}
