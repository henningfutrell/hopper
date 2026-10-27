// The token budget (issue #2302, part 3, design.md "The token ledger"): the user's cap on what one job may spend, in tokens
// (every token, as the ledger views count them) or in estimated cost; 0: no cap. A running job whose token ledger reaches
// it is paused — parked, its agent session and work tree kept — and Needs you lists it. A person's pick up lets it go on:
// the cap then counts again from what it had spent then (`budgetFrom`). Part 5, the day budgets: the most the user's jobs
// may spend in one UTC day, in all or per repository; while one is reached, a waiting job it covers is held in admission. Pure.
import { sumTokenUse, type TokenLedgerEntry, type TokenTotals } from './token-usage.ts';

export interface TokenBudgetSettings {
  /** The most tokens one job may use (input, output, cache read and cache write); 0: no cap. */
  jobTokens: number;
  /** The most estimated cost one job may use, in US dollars; 0: no cap. */
  jobCostUsd: number;
  /** The most tokens all the user's jobs may use in one UTC day (part 5); 0: no cap. */
  dayTokens: number;
  /** The most estimated cost all the user's jobs may use in one UTC day, in US dollars; 0: no cap. */
  dayCostUsd: number;
  /** The most tokens the jobs of each repository may use in one UTC day; 0: no cap. */
  repoDayTokens: number;
  /** The most estimated cost the jobs of each repository may use in one UTC day, in US dollars; 0: no cap. */
  repoDayCostUsd: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetSettings = { jobTokens: 0, jobCostUsd: 0, dayTokens: 0, dayCostUsd: 0, repoDayTokens: 0, repoDayCostUsd: 0 };

/** The highest cap a person may set. */
export const MAX_BUDGET_TOKENS = 1e12;
export const MAX_BUDGET_COST_USD = 1e6;

/** What a job spent: every token, and the estimated cost. */
export interface TokenSpend { tokens: number; costUsd: number }

/**
 * A job paused by its token budget: when, what it had spent then, and why. Kept until a person picks it up. `stalled`: a
 * cheap job paused for its waste signals, not its budget (issue #2848 part 3).
 */
export interface JobBudgetPaused extends TokenSpend { at: string; why: string; stalled?: true }

export const spendOf = (t: TokenTotals): TokenSpend => ({ tokens: t.input + t.output + t.cacheRead + t.cacheWrite, costUsd: t.costUsd });

/** The stored setting, or the default; a cap a setting stored before it does not name is off. */
export const tokenBudgetOf = (s: Partial<TokenBudgetSettings> | undefined): TokenBudgetSettings => ({ ...DEFAULT_TOKEN_BUDGET, ...s });

const tokensText = (n: number): string => `${Math.round(n).toLocaleString('en-US')} tokens`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Why the job's spend, counted from `from` (a person let it go on then), reached its budget; undefined: it did not. */
export function budgetReached(spend: TokenSpend, from: TokenSpend | undefined, s: TokenBudgetSettings): string | undefined {
  const since = from ? ' since it was let go on' : '';
  const tokens = spend.tokens - (from?.tokens ?? 0), cost = spend.costUsd - (from?.costUsd ?? 0);
  if (s.jobTokens > 0 && tokens >= s.jobTokens) return `Paused: the job used ${tokensText(tokens)}${since}, its token budget is ${tokensText(s.jobTokens)}.`;
  if (s.jobCostUsd > 0 && cost >= s.jobCostUsd) return `Paused: the job used an estimated ${usd(cost)}${since}, its cost budget is ${usd(s.jobCostUsd)}.`;
  return undefined;
}

/** From this share of a cap, a job is near its budget (issue #2848 part 3): checkpointed each minute, not each ten. */
export const BUDGET_NEAR = 0.8;

/** Whether the job's spend since `from` is at BUDGET_NEAR of a cap or more. */
export function budgetNear(spend: TokenSpend, from: TokenSpend | undefined, s: TokenBudgetSettings): boolean {
  const tokens = spend.tokens - (from?.tokens ?? 0), cost = spend.costUsd - (from?.costUsd ?? 0);
  return (s.jobTokens > 0 && tokens >= s.jobTokens * BUDGET_NEAR) || (s.jobCostUsd > 0 && cost >= s.jobCostUsd * BUDGET_NEAR);
}

/** What the user's jobs spent on one UTC day (`YYYY-MM-DD`): in all, and per repository. */
export interface DaySpend { day: string; total: TokenSpend; repos: Record<string, TokenSpend> }

/** Whether a day cap is on: else no Decision reads the ledger for it. */
export const dayBudgetOn = (s: TokenBudgetSettings): boolean => s.dayTokens > 0 || s.dayCostUsd > 0 || s.repoDayTokens > 0 || s.repoDayCostUsd > 0;

/** The day's spend: the rows whose session's last counted message is on `day`, as the ledger's `day` group counts them. */
export function daySpendOf(entries: readonly TokenLedgerEntry[], day: string, repoOf: (jobId: string) => string | undefined): DaySpend {
  const mine = entries.filter((e) => (e.last ?? e.readAt).slice(0, 10) === day);
  const byRepo = new Map<string, TokenLedgerEntry[]>();
  for (const e of mine) {
    const repo = repoOf(e.jobId);
    if (repo !== undefined) byRepo.set(repo, [...(byRepo.get(repo) ?? []), e]);
  }
  return { day, total: spendOf(sumTokenUse(mine)), repos: Object.fromEntries([...byRepo].map(([r, es]) => [r, spendOf(sumTokenUse(es))])) };
}

/** Which cap of a pair the spend reached: its words, or undefined. */
function capReached(spend: TokenSpend | undefined, tokens: number, cost: number): string | undefined {
  if (!spend) return undefined;
  if (tokens > 0 && spend.tokens >= tokens) return `token budget of ${tokensText(tokens)}`;
  if (cost > 0 && spend.costUsd >= cost) return `cost budget of ${usd(cost)}`;
  return undefined;
}

/**
 * Why a waiting job of `repo` is held by a day budget, or undefined: it is not. The day's cap covers every job; the
 * repository's, the jobs of a repository whose own spend reached it. The words do not change with the spend, so a
 * held job is held once, not again at each checkpoint.
 */
export function dayBudgetHold(repo: string | undefined, spend: DaySpend, s: TokenBudgetSettings): string | undefined {
  const until = 'until the next UTC day, or until an admin raises the budget.';
  const day = capReached(spend.total, s.dayTokens, s.dayCostUsd);
  if (day) return `Held by the token budget: the jobs used the day's ${day} on ${spend.day} (UTC). No job starts or goes on ${until}`;
  const own = repo === undefined ? undefined : capReached(spend.repos[repo], s.repoDayTokens, s.repoDayCostUsd);
  if (own) return `Held by the token budget: the jobs of ${repo} used its day's ${own} on ${spend.day} (UTC). No job of ${repo} starts or goes on ${until}`;
  return undefined;
}
