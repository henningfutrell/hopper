// The token ledger's words (issue #2302): token counts and an estimated cost as a person reads them, and the ledger by
// day as the Dashboard's tokens over time stacks it (part 2); the token budget in Settings and Needs you (part 3); the waste
// signals and tokens per merged pull request (part 4); a job's model route and its budget (issue #2848). Pure.
import { goalOf } from './job.ts';
import type { Job, PerMergedPullRequest, TokenBudgetSettings, TokenRollupRow, TokenTotals, TokenWasteKind } from './wire.ts';

/** A token count in short: 950, 12.3k, 2.4M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** An estimated cost in US dollars; `~` before it when a model in it has no known price. */
export const usd = (t: Pick<TokenTotals, 'costUsd' | 'costKnown'>): string => `${t.costKnown ? '' : '~'}$${t.costUsd.toFixed(2)}`;

/** Its counts in one line: turns, input, output, cache read and cache write; its failed test runs when it has some. */
export const tokenLine = (t: TokenTotals): string =>
  `${t.turns} turns · ${tokenCount(t.input)} in · ${tokenCount(t.output)} out · ${tokenCount(t.cacheRead)} cache read · ${tokenCount(t.cacheWrite)} cache write`
  + (t.failedTests ? ` · ${t.failedTests} failed test run${t.failedTests === 1 ? '' : 's'}` : '');

type ModelRoute = NonNullable<Job['spec']['modelRoute']>;
const CHOICE_NAMES: Record<ModelRoute['choice'], string> = { cheap: 'Cheap model', strong: 'Strong model' };

/** A job's model route as its job view says it (issue #2848): the choice and model, why, and its budget against its spend. */
export function modelRouteLines(r: ModelRoute, spent: TokenTotals | undefined): { route: string; why: string; budget: string } {
  const escalated = r.escalated ? ` · escalated from the ${r.escalated.from} model` : '';
  const caps = [
    r.budget.jobCostUsd > 0 ? `$${(spent?.costUsd ?? 0).toFixed(2)} of $${r.budget.jobCostUsd.toFixed(2)}` : undefined,
    r.budget.jobTokens > 0 ? `${tokenCount(spent ? tokensOf(spent) : 0)} of ${tokenCount(r.budget.jobTokens)} tokens` : undefined,
  ].filter((c) => c !== undefined);
  return {
    route: `${CHOICE_NAMES[r.choice]}: ${r.model || 'the agent\'s default'}${escalated}`, why: r.why,
    budget: caps.length > 0 ? `Budget: ${caps.join(' · ')} spent` : 'Budget: the token budget\'s job caps',
  };
}

/** Each waste signal's name. */
export const WASTE_NAMES: Record<TokenWasteKind, string> = { no_progress: 'No progress', failing_tests: 'Failing tests', resume_loop: 'Resume loop', cache_churn: 'Cache churn' };

/** Tokens per merged pull request in one line, or that none was merged. */
export const perMergedLine = (p: PerMergedPullRequest): string =>
  p.pullRequests > 0 && p.tokens !== undefined
    ? `${tokenCount(Math.round(p.tokens))} tokens · $${(p.costUsd ?? 0).toFixed(2)} per merged pull request (${p.pullRequests} merged)`
    : 'No pull request merged in this range.';

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

/** The token budget, what is on now: a sentence for each kind of cap. */
export function tokenBudgetSummary(s: TokenBudgetSettings): string {
  const either = (tokens: number, cost: number): string | undefined => {
    const t = tokens > 0 ? `${tokenCount(tokens)} tokens` : undefined;
    const c = cost > 0 ? `an estimated $${cost.toFixed(2)}` : undefined;
    return t && c ? `${t} or ${c}` : t ?? c;
  };
  const job = either(s.jobTokens, s.jobCostUsd), day = either(s.dayTokens, s.dayCostUsd), repo = either(s.repoDayTokens, s.repoDayCostUsd);
  const lines = [
    job && `A job is paused when it used ${job}${s.jobTokens > 0 && s.jobCostUsd > 0 ? ', whichever comes first' : ''}.`,
    day && `No job starts or goes on once the jobs used ${day} in a day (UTC).`,
    repo && `No job of a repository starts or goes on once its jobs used ${repo} in a day (UTC).`,
  ].filter((l): l is string => !!l);
  return lines.length ? lines.join(' ') : 'Off: no job is paused or held for what it spends.';
}

/** Each cap of the token budget, and whether it counts tokens (a whole number) or US dollars. */
export const TOKEN_BUDGET_CAPS = [
  ['jobTokens', true], ['jobCostUsd', false], ['dayTokens', true], ['dayCostUsd', false], ['repoDayTokens', true], ['repoDayCostUsd', false],
] as const satisfies readonly (readonly [keyof TokenBudgetSettings, boolean])[];

export type TokenBudgetDraft = Record<keyof TokenBudgetSettings, string>;

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. An empty field is 0. */
export function tokenBudgetPatch(s: TokenBudgetSettings, d: TokenBudgetDraft): { ok: true; patch: Partial<TokenBudgetSettings> | undefined } | { ok: false; error: string } {
  const patch: Partial<TokenBudgetSettings> = {};
  for (const [key, whole] of TOKEN_BUDGET_CAPS) {
    const n = Number(d[key].trim() || '0');
    if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) return { ok: false, error: whole ? 'Tokens: a whole number from 0' : 'Cost: a number of US dollars from 0' };
    if (n !== s[key]) patch[key] = n;
  }
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}
