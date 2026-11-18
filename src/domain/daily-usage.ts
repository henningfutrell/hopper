// The daily usage trend (issue #2966 part 4, design.md "The daily usage trend"): each day of daily usage the
// `claude-analytics` usage source read, kept per account and UTC day so Usage shows a trend and not only the last day.
// Counts only: the user's own matched accounts, never another member's row, a user id or the key.
import type { DailyUsage } from './usage.ts';

/** How many days of daily usage are kept. */
export const DAILY_USAGE_KEPT_DAYS = 90;
/** The days a trend shows when none are asked for. */
export const DAILY_USAGE_TREND_DAYS = 30;

/** `GET /api/usage/daily`: the kept days of daily usage from `from` to `to` (UTC days, `to` the day before today). */
export interface DailyUsageTrend {
  days: number;
  from: string;
  to: string;
  /** One row per account and day, oldest day first, then by account. */
  daily: DailyUsage[];
}

/** One row per account and UTC day (tenant migration 110). */
export interface DailyUsageRepository {
  /** Keeps each day, in place of a row of the same account and day; then drops each row older than `keepFrom` (`YYYY-MM-DD`). */
  keep(days: readonly DailyUsage[], keepFrom: string): void;
  /** Every row of `from` (`YYYY-MM-DD`) and later, oldest day first, then by account. */
  since(from: string): DailyUsage[];
}

const DAY_MS = 86_400_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The first day kept on `now`: rows older than this go. */
export const dailyUsageKeepFrom = (now: Date): string => day(now.getTime() - DAILY_USAGE_KEPT_DAYS * DAY_MS);

/** The `days` UTC days a trend covers on `now`: up to the day before today, the newest the Analytics API has. */
export function dailyUsageRange(now: Date, days: number): { from: string; to: string } {
  const to = now.getTime() - DAY_MS;
  return { from: day(to - (days - 1) * DAY_MS), to: day(to) };
}
