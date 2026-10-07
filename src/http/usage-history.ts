// The usage graph's reads (issue #385, design.md "Usage history"): GET /api/usage/history, the request's
// user's own lines — the graph range and graph step asked in the query, else the ones the user chose — and
// GET /api/instance/usage-history, the instance admin's: every user's lines summed per unit and usage
// window, nothing named (issues #221, #241). The user's choice and the history retention are changed
// through POST /ui/api/usage-history/* (ui/index.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, UsageHistoryQuery } from '../domain/ports.ts';
import {
  DEFAULT_HISTORY_RETENTION_DAYS, DEFAULT_USAGE_GRAPH_VIEW, PRESET_MS, STEP_MS, USAGE_GRAPH_PRESETS, USAGE_GRAPH_STEPS,
  type InstanceUsageHistory, type UsageGraphView, type UsageHistory, type UsageTotalSeries,
} from '../domain/types.ts';
import { parseWith } from './errors.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';
import type { TenantParts, Tenants } from './tenants.ts';

const time = z.iso.datetime({ offset: true });

/** A graph range: a preset, or a fixed stretch with `from` before `to`. */
export const usageGraphRange = z.union([
  z.strictObject({ preset: z.enum(USAGE_GRAPH_PRESETS) }),
  z.strictObject({ from: time, to: time }).refine((r) => Date.parse(r.from) < Date.parse(r.to), 'from must be before to'),
]);

export const usageGraphViewBody = z.strictObject({ range: usageGraphRange, step: z.enum(USAGE_GRAPH_STEPS) });

export const usageHistoryQuery = z.object({
  range: z.enum(USAGE_GRAPH_PRESETS).optional(),
  from: time.optional(),
  to: time.optional(),
  step: z.enum(USAGE_GRAPH_STEPS).optional(),
  /** The viewer's offset from UTC in minutes (east positive): a day step starts at their midnight. */
  tz: z.coerce.number().int().min(-14 * 60).max(14 * 60).default(0),
}).refine((q) => (q.from === undefined) === (q.to === undefined), 'from and to go together')
  .refine((q) => q.from === undefined || q.range === undefined, 'range or from and to, not both')
  .refine((q) => q.from === undefined || Date.parse(q.from) < Date.parse(q.to!), 'from must be before to');

/** Steps count from a Monday midnight in the viewer's time: a week step is Monday to Monday. */
const MONDAY = Date.parse('2000-01-03T00:00:00.000Z');

/** The view a request asks: what the query names over the saved view (else the default). */
function viewOf(q: z.infer<typeof usageHistoryQuery>, saved: UsageGraphView | undefined): UsageGraphView {
  const base = saved ?? DEFAULT_USAGE_GRAPH_VIEW;
  const range = q.range ? { preset: q.range } : q.from && q.to ? { from: q.from, to: q.to } : base.range;
  return { range, step: q.step ?? base.step };
}

/** The view as a query of the history: its stretch now, its step, and the origin of its steps. */
export function historyQuery(view: UsageGraphView, now: Date, tzMinutes: number): UsageHistoryQuery {
  const to = 'preset' in view.range ? now : new Date(view.range.to);
  const from = 'preset' in view.range ? new Date(now.getTime() - PRESET_MS[view.range.preset]) : new Date(view.range.from);
  return { from, to, stepMs: STEP_MS[view.step], originMs: MONDAY - tzMinutes * 60_000 };
}

export function usageHistory(t: TenantParts, query: unknown, now: Date): UsageHistory {
  const q = parseWith(usageHistoryQuery, query);
  const view = viewOf(q, t.store.settings.getUsageGraphView());
  const h = historyQuery(view, now, q.tz);
  return {
    view, from: h.from.toISOString(), to: h.to.toISOString(), stepMs: h.stepMs,
    retentionDays: t.store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS,
    series: t.store.usageHistory.series(h),
  };
}

/** Every user's lines summed per unit, usage window and graph step: a sum of `%` is a share of the summed limit. */
export function instanceUsageHistory(tenants: Pick<Tenants, 'list' | 'user'>, query: unknown, now: Date): InstanceUsageHistory {
  const q = parseWith(usageHistoryQuery, query);
  const view = viewOf(q, undefined);
  const h = historyQuery(view, now, q.tz);
  const sums = new Map<string, { series: Omit<UsageTotalSeries, 'points'>; at: Map<string, { used: number; limit: number; series: number }> }>();
  for (const u of tenants.list()) {
    for (const s of tenants.user(u.id)?.store.usageHistory.totals(h) ?? []) {
      const key = JSON.stringify([s.unit, s.window ?? null, s.informational]);
      const sum = sums.get(key) ?? { series: { unit: s.unit, ...(s.window !== undefined ? { window: s.window } : {}), informational: s.informational }, at: new Map() };
      for (const p of s.points) {
        const a = sum.at.get(p.at) ?? { used: 0, limit: 0, series: 0 };
        sum.at.set(p.at, { used: a.used + p.used, limit: a.limit + p.limit, series: a.series + p.series });
      }
      sums.set(key, sum);
    }
  }
  const totals = [...sums.values()].map(({ series, at }): UsageTotalSeries => ({
    ...series,
    points: [...at.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, p]) => ({ at: t, usedFrac: p.limit > 0 ? p.used / p.limit : 0, series: p.series })),
  }));
  return { view, from: h.from.toISOString(), to: h.to.toISOString(), stepMs: h.stepMs, totals };
}

export function usageHistoryRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; tenants: Pick<Tenants, 'list' | 'user'>; clock: Clock; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/usage/history', async (req): Promise<UsageHistory> => usageHistory(o.tenant(req), req.query, o.clock.now()));
  app.get('/api/instance/usage-history', async (req): Promise<InstanceUsageHistory> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the instance usage history');
    return instanceUsageHistory(o.tenants, req.query, o.clock.now());
  });
}
