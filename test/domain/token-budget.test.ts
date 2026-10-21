// Issue #2302, part 3: the token budget. A job whose token use since its run began — or since a person let it go on past
// its budget — reaches the user's per-job cap, in tokens or in estimated cost, is paused. Pure.
import { describe, expect, it } from 'vitest';
import { budgetReached, spendOf, tokenBudgetOf, DEFAULT_TOKEN_BUDGET } from '../../src/domain/token-budget.ts';
import type { TokenTotals } from '../../src/domain/token-usage.ts';

const totals = (o: Partial<TokenTotals>): TokenTotals => ({ turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnown: true, ...o });

describe('the token budget (issue #2302, part 3)', () => {
  it('counts every token, as the ledger views do, and the estimated cost', () => {
    expect(spendOf(totals({ input: 1, output: 2, cacheRead: 30, cacheWrite: 400, costUsd: 0.5 }))).toEqual({ tokens: 433, costUsd: 0.5 });
  });

  it('is off by default: no cap is reached', () => {
    expect(DEFAULT_TOKEN_BUDGET).toEqual({ jobTokens: 0, jobCostUsd: 0 });
    expect(budgetReached({ tokens: 1e12, costUsd: 1e6 }, undefined, DEFAULT_TOKEN_BUDGET)).toBeUndefined();
  });

  it('is reached at the token cap, and says so in plain words', () => {
    const s = { jobTokens: 1_000_000, jobCostUsd: 0 };
    expect(budgetReached({ tokens: 999_999, costUsd: 9 }, undefined, s)).toBeUndefined();
    expect(budgetReached({ tokens: 1_000_000, costUsd: 9 }, undefined, s)).toBe('Paused: the job used 1,000,000 tokens, its token budget is 1,000,000 tokens.');
  });

  it('is reached at the cost cap', () => {
    const s = { jobTokens: 0, jobCostUsd: 2 };
    expect(budgetReached({ tokens: 5, costUsd: 1.99 }, undefined, s)).toBeUndefined();
    expect(budgetReached({ tokens: 5, costUsd: 2.5 }, undefined, s)).toBe('Paused: the job used an estimated $2.50, its cost budget is $2.00.');
  });

  it('counts from where a person let the job go on: each go-on gives a whole budget again', () => {
    const s = { jobTokens: 100, jobCostUsd: 1 };
    const from = { tokens: 150, costUsd: 1.2 };
    expect(budgetReached({ tokens: 249, costUsd: 2.1 }, from, s)).toBeUndefined();
    expect(budgetReached({ tokens: 250, costUsd: 2.1 }, from, s)).toBe('Paused: the job used 100 tokens since it was let go on, its token budget is 100 tokens.');
    expect(budgetReached({ tokens: 200, costUsd: 2.2 }, from, s)).toBe('Paused: the job used an estimated $1.00 since it was let go on, its cost budget is $1.00.');
  });

  it('reads the stored setting, or the default', () => {
    expect(tokenBudgetOf(undefined)).toEqual(DEFAULT_TOKEN_BUDGET);
    expect(tokenBudgetOf({ jobTokens: 5, jobCostUsd: 0 })).toEqual({ jobTokens: 5, jobCostUsd: 0 });
  });
});
