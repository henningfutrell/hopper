// The token budget (issue #2302, part 3, design.md "The token ledger"): the user's cap on what one job may spend, in tokens
// (every token, as the ledger views count them) or in estimated cost; 0: no cap. A running job whose token ledger reaches
// it is paused — parked, its agent session and work tree kept — and Needs you lists it. A person's pick up lets it go on:
// the cap then counts again from what it had spent then (`budgetFrom`). Pure.
import type { TokenTotals } from './token-usage.ts';

export interface TokenBudgetSettings {
  /** The most tokens one job may use (input, output, cache read and cache write); 0: no cap. */
  jobTokens: number;
  /** The most estimated cost one job may use, in US dollars; 0: no cap. */
  jobCostUsd: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetSettings = { jobTokens: 0, jobCostUsd: 0 };

/** The highest cap a person may set. */
export const MAX_BUDGET_TOKENS = 1e12;
export const MAX_BUDGET_COST_USD = 1e6;

/** What a job spent: every token, and the estimated cost. */
export interface TokenSpend { tokens: number; costUsd: number }

/** A job paused by its token budget: when, what it had spent then, and why. Kept until a person picks it up. */
export interface JobBudgetPaused extends TokenSpend { at: string; why: string }

export const spendOf = (t: TokenTotals): TokenSpend => ({ tokens: t.input + t.output + t.cacheRead + t.cacheWrite, costUsd: t.costUsd });

export const tokenBudgetOf = (s: TokenBudgetSettings | undefined): TokenBudgetSettings => s ?? DEFAULT_TOKEN_BUDGET;

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
