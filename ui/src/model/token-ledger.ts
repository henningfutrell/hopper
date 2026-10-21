// The token ledger's words (issue #2302): token counts and an estimated cost as a person reads them, and the ledger by
// day as the Dashboard's tokens over time stacks it (part 2). Pure.
import { goalOf } from './job.ts';
import type { Job, TokenRollupRow, TokenTotals } from './wire.ts';

/** A token count in short: 950, 12.3k, 2.4M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** An estimated cost in US dollars; `~` before it when a model in it has no known price. */
export const usd = (t: Pick<TokenTotals, 'costUsd' | 'costKnown'>): string => `${t.costKnown ? '' : '~'}$${t.costUsd.toFixed(2)}`;

/** Its counts in one line: turns, input, output, cache read and cache write. */
export const tokenLine = (t: TokenTotals): string =>
  `${t.turns} turns · ${tokenCount(t.input)} in · ${tokenCount(t.output)} out · ${tokenCount(t.cacheRead)} cache read · ${tokenCount(t.cacheWrite)} cache write`;

/** Every token of a row: input, output, cache read and cache write. */
export const tokensOf = (t: Pick<TokenTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** One stack of a day: a repository's or an account's tokens and estimated cost. */
export interface TokenDayPart { key: string; tokens: number; costUsd: number }
/** One UTC day of tokens over time: its tokens and cost, and its stacks, which sum to it. */
export interface TokenDay { day: string; tokens: number; costUsd: number; parts: TokenDayPart[] }
export interface TokenStack { key: string; color: string }

const STACK_COLORS = ['var(--busy)', 'var(--ok)', 'var(--warn)', 'var(--question)', 'var(--operator)', 'var(--bad)'] as const;
/** The stack that holds what the biggest ones leave. */
export const OTHER = 'other';
const DAY = 86_400_000;

/**
 * The ledger by day, split by a second group (GET /api/usage/tokens?by=day&split=…), as `days` UTC days up to `today`
 * (`YYYY-MM-DD`): every day, one with no use too. The `most` biggest stacks over the range keep their own colour, the
 * biggest first; the rest are summed as `other`, so each day still sums to what the ledger says.
 */
export function tokenDays(groups: readonly TokenRollupRow[], days: number, today: string, most = STACK_COLORS.length - 1): { days: TokenDay[]; stacks: TokenStack[] } {
  const end = Date.parse(`${today}T00:00:00.000Z`);
  const keys = Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY).toISOString().slice(0, 10));
  const byDay = new Map(groups.map((g) => [g.key, g]));
  const sizes = new Map<string, number>();
  for (const k of keys) for (const p of byDay.get(k)?.parts ?? []) sizes.set(p.key, (sizes.get(p.key) ?? 0) + tokensOf(p));
  const ranked = [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const own = new Set(ranked.slice(0, most));
  const stacks: TokenStack[] = ranked.slice(0, most).map((key, i) => ({ key, color: STACK_COLORS[i % STACK_COLORS.length]! }));
  if (ranked.length > most) stacks.push({ key: OTHER, color: 'var(--muted-foreground)' });
  return {
    stacks,
    days: keys.map((day) => {
      const parts = new Map<string, TokenDayPart>();
      for (const p of byDay.get(day)?.parts ?? []) {
        const key = own.has(p.key) ? p.key : OTHER;
        const was = parts.get(key) ?? { key, tokens: 0, costUsd: 0 };
        parts.set(key, { key, tokens: was.tokens + tokensOf(p), costUsd: was.costUsd + p.costUsd });
      }
      const shown = stacks.flatMap((s) => (parts.has(s.key) ? [parts.get(s.key)!] : []));
      return { day, tokens: shown.reduce((n, p) => n + p.tokens, 0), costUsd: shown.reduce((n, p) => n + p.costUsd, 0), parts: shown };
    }),
  };
}

/** Needs you's Budgets row (issue #2302, part 3): each parked job its token budget paused, with why. */
export const budgetPausedLines = (jobs: readonly Job[]): string[] =>
  jobs.filter((j) => j.status === 'parked' && j.budgetPaused).map((j) => `${goalOf(j)}: ${j.budgetPaused!.why} Pick it up to let it go on.`);
