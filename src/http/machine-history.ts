// The resource graph's reads (issue #560, design.md "Machine resources over time"): GET /api/machines/history, every
// machine's lines of the request's user, and GET /api/machines/:id/history, one machine's — the graph range asked
// in the query (the usage graph's query), else the last day, at the resource graph's step for it. The history
// retention is the usage history's, changed through POST /ui/api/usage-history/retention.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import {
  DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_MACHINE_GRAPH_VIEW, PRESET_MS, resourceStepMs, type MachineHistory, type UsageGraphView,
} from '../domain/types.ts';
import { parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';
import { MONDAY, usageHistoryQuery } from './usage-history.ts';

const machineParams = z.object({ id: z.string().min(1).max(200) });

export function machineHistory(t: TenantParts, query: unknown, now: Date, machineId?: string): MachineHistory {
  const q = parseWith(usageHistoryQuery, query);
  const view: UsageGraphView = q.range ? { range: { preset: q.range } } : q.from && q.to ? { range: { from: q.from, to: q.to } } : DEFAULT_MACHINE_GRAPH_VIEW;
  const to = 'preset' in view.range ? now : new Date(view.range.to);
  const from = 'preset' in view.range ? new Date(now.getTime() - PRESET_MS[view.range.preset]) : new Date(view.range.from);
  const stepMs = resourceStepMs(to.getTime() - from.getTime());
  return {
    view, from: from.toISOString(), to: to.toISOString(), stepMs,
    retentionDays: t.store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS,
    series: t.store.machineHistory.series({ from, to, stepMs, originMs: MONDAY - q.tz * 60_000, ...(machineId !== undefined ? { machineId } : {}) }),
  };
}

export function machineHistoryRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/machines/history', async (req): Promise<MachineHistory> => machineHistory(o.tenant(req), req.query, o.clock.now()));
  app.get('/api/machines/:id/history', async (req): Promise<MachineHistory> =>
    machineHistory(o.tenant(req), req.query, o.clock.now(), parseWith(machineParams, req.params).id));
}
