// The resource graph's reads (issue #560, design.md "Machine resources over time"): GET /api/machines/history, every
// machine's lines of the request's user, and GET /api/machines/:id/history, one machine's — the graph range asked
// in the query (the usage graph's query), else the last day, at the resource graph's step for it. One machine's also
// carries the usage that limits it and its lane changes in the range (issue #688, design.md "Lane tuning"). The history
// retention is the usage history's, changed through POST /ui/api/usage-history/retention. Both carry the memory alert
// (issue #868), set through POST /ui/api/machines/memory-alert.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import {
  DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_MACHINE_GRAPH_VIEW, LANE_CHANGE_EVENTS, laneChangeOf, PRESET_MS, resourceStepMs, type MachineHistory,
  type UsageGraphView,
} from '../domain/types.ts';
import { parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';
import { MONDAY, usageHistoryQuery } from './usage-history.ts';

const machineParams = z.object({ id: z.string().min(1).max(200) });

/** A resource graph's range (the machines' and the stack's, issue #947): the query's, else the last day, at the resource step for it. */
export function resourceGraphRange(query: unknown, now: Date): { view: UsageGraphView; from: Date; to: Date; stepMs: number; originMs: number } {
  const q = parseWith(usageHistoryQuery, query);
  const view: UsageGraphView = q.range ? { range: { preset: q.range } } : q.from && q.to ? { range: { from: q.from, to: q.to } } : DEFAULT_MACHINE_GRAPH_VIEW;
  const to = 'preset' in view.range ? now : new Date(view.range.to);
  const from = 'preset' in view.range ? new Date(now.getTime() - PRESET_MS[view.range.preset]) : new Date(view.range.from);
  return { view, from, to, stepMs: resourceStepMs(to.getTime() - from.getTime()), originMs: MONDAY - q.tz * 60_000 };
}

export function machineHistory(t: TenantParts, query: unknown, now: Date, machineId?: string): MachineHistory {
  const { view, ...h } = resourceGraphRange(query, now);
  const { from, to, stepMs } = h;
  return {
    view, from: from.toISOString(), to: to.toISOString(), stepMs,
    retentionDays: t.store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS,
    series: t.store.machineHistory.series({ ...h, ...(machineId !== undefined ? { machineId } : {}) }),
    ...memoryAlertOf(t),
    ...(machineId !== undefined ? { usage: t.store.usageHistory.series({ ...h, limiting: machineId }), laneChanges: laneChangesOf(t, machineId, from, to) } : {}),
  };
}

const memoryAlertOf = (t: TenantParts): Pick<MachineHistory, 'memoryAlert'> => {
  const a = t.store.settings.getMemoryAlert();
  return a ? { memoryAlert: a } : {};
};

/** One machine's lane changes in [from, to), oldest first. */
const laneChangesOf = (t: TenantParts, machineId: string, from: Date, to: Date) => t.store.events.between(LANE_CHANGE_EVENTS, from.toISOString())
  .filter((e) => Date.parse(e.at) < to.getTime()).map(laneChangeOf).filter((c) => c.machineId === machineId);

export function machineHistoryRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/machines/history', async (req): Promise<MachineHistory> => machineHistory(o.tenant(req), req.query, o.clock.now()));
  app.get('/api/machines/:id/history', async (req): Promise<MachineHistory> =>
    machineHistory(o.tenant(req), req.query, o.clock.now(), parseWith(machineParams, req.params).id));
}
