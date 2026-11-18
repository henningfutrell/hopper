// The daily usage trend's read (issue #2966 part 4, design.md "The daily usage trend"): GET /api/usage/daily?days=N, the
// request's user's kept days of daily usage from the `claude-analytics` usage source, N days up to yesterday (UTC), at
// most the 90 days kept. Counts only: the user's own matched accounts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import { DAILY_USAGE_KEPT_DAYS, DAILY_USAGE_TREND_DAYS, dailyUsageRange, type DailyUsageTrend } from '../domain/types.ts';
import { parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

export const dailyUsageQuery = z.object({
  days: z.coerce.number().int().min(1).max(DAILY_USAGE_KEPT_DAYS).default(DAILY_USAGE_TREND_DAYS)
    .meta({ description: `how many UTC days, up to yesterday (default ${DAILY_USAGE_TREND_DAYS}, at most ${DAILY_USAGE_KEPT_DAYS})` }),
});

export function dailyUsageTrend(t: Pick<TenantParts, 'store'>, query: unknown, now: Date): DailyUsageTrend {
  const { days } = parseWith(dailyUsageQuery, query);
  const { from, to } = dailyUsageRange(now, days);
  return { days, from, to, daily: t.store.dailyUsage.since(from).filter((d) => d.date <= to) };
}

export function dailyUsageRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => Pick<TenantParts, 'store'>; clock: Clock }): void {
  app.get('/api/usage/daily', async (req): Promise<DailyUsageTrend> => dailyUsageTrend(o.tenant(req), req.query, o.clock.now()));
}
