// Daily usage from the Claude Enterprise Analytics API (issue #2966, glossary "Daily usage") as the Usage page writes it:
// one account's day in short words, and the kept days as a trend (part 4), stacked by account. Pure.
import { tokenCount, tokenDays, type TokenDay, type TokenStack } from './token-ledger.ts';
import type { DailyUsage } from './wire.ts';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One account's day: its cost, its tokens, and its Claude Code work. */
export function dayFacts(d: DailyUsage): { cost: string; tokens: string; work: string } {
  const t = d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheCreation;
  return {
    cost: `$${(d.costCents / 100).toFixed(2)}`,
    tokens: `${tokenCount(t)} tokens`,
    work: [count(d.sessions, 'session', 'sessions'), count(d.commits, 'commit', 'commits'),
      count(d.pullRequests, 'pull request', 'pull requests'), `+${d.linesAdded} −${d.linesRemoved} lines`].join(' · '),
  };
}

/**
 * The kept days as the trend chart draws them: every UTC day of the `days` up to `to`, one with no row too, stacked by
 * account; each day's tokens and cost (US dollars).
 */
export function dailyTrend(rows: readonly DailyUsage[], days: number, to: string): { days: TokenDay[]; stacks: TokenStack[] } {
  const byDay = new Map<string, DailyUsage[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const totals = (d: Pick<DailyUsage, 'tokens' | 'costCents'>) => ({
    input: d.tokens.input, output: d.tokens.output, cacheRead: d.tokens.cacheRead, cacheWrite: d.tokens.cacheCreation,
    costUsd: d.costCents / 100, costKnown: true, turns: 0, jobs: 0,
  });
  const groups = [...byDay].map(([day, rs]) => ({ key: day, ...totals({ tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costCents: 0 }), parts: rs.map((r) => ({ key: r.account, ...totals(r) })) }));
  return tokenDays(groups, days, to);
}
