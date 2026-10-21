// Issue #2302, part 3: the token budget. A job whose token use since its run began — or since a person let it go on past
// its budget — reaches the user's per-job cap, in tokens or in estimated cost, is paused. Pure.
import { describe, expect, it } from 'vitest';
import { budgetReached, dayBudgetHold, daySpendOf, spendOf, tokenBudgetOf, DEFAULT_TOKEN_BUDGET, type TokenBudgetSettings } from '../../src/domain/token-budget.ts';
import type { TokenLedgerEntry, TokenTotals } from '../../src/domain/token-usage.ts';

const totals = (o: Partial<TokenTotals>): TokenTotals => ({ turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnown: true, ...o });

describe('the token budget (issue #2302, part 3)', () => {
  it('counts every token, as the ledger views do, and the estimated cost', () => {
    expect(spendOf(totals({ input: 1, output: 2, cacheRead: 30, cacheWrite: 400, costUsd: 0.5 }))).toEqual({ tokens: 433, costUsd: 0.5 });
  });

  it('is off by default: no cap is reached', () => {
    expect(DEFAULT_TOKEN_BUDGET).toEqual({ jobTokens: 0, jobCostUsd: 0, dayTokens: 0, dayCostUsd: 0, repoDayTokens: 0, repoDayCostUsd: 0 });
    expect(budgetReached({ tokens: 1e12, costUsd: 1e6 }, undefined, DEFAULT_TOKEN_BUDGET)).toBeUndefined();
  });

  it('is reached at the token cap, and says so in plain words', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, jobTokens: 1_000_000 };
    expect(budgetReached({ tokens: 999_999, costUsd: 9 }, undefined, s)).toBeUndefined();
    expect(budgetReached({ tokens: 1_000_000, costUsd: 9 }, undefined, s)).toBe('Paused: the job used 1,000,000 tokens, its token budget is 1,000,000 tokens.');
  });

  it('is reached at the cost cap', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, jobCostUsd: 2 };
    expect(budgetReached({ tokens: 5, costUsd: 1.99 }, undefined, s)).toBeUndefined();
    expect(budgetReached({ tokens: 5, costUsd: 2.5 }, undefined, s)).toBe('Paused: the job used an estimated $2.50, its cost budget is $2.00.');
  });

  it('counts from where a person let the job go on: each go-on gives a whole budget again', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, jobTokens: 100, jobCostUsd: 1 };
    const from = { tokens: 150, costUsd: 1.2 };
    expect(budgetReached({ tokens: 249, costUsd: 2.1 }, from, s)).toBeUndefined();
    expect(budgetReached({ tokens: 250, costUsd: 2.1 }, from, s)).toBe('Paused: the job used 100 tokens since it was let go on, its token budget is 100 tokens.');
    expect(budgetReached({ tokens: 200, costUsd: 2.2 }, from, s)).toBe('Paused: the job used an estimated $1.00 since it was let go on, its cost budget is $1.00.');
  });

  it('reads the stored setting, or the default; a setting stored before the day caps has them off', () => {
    expect(tokenBudgetOf(undefined)).toEqual(DEFAULT_TOKEN_BUDGET);
    expect(tokenBudgetOf({ jobTokens: 5, jobCostUsd: 0 } as TokenBudgetSettings)).toEqual({ ...DEFAULT_TOKEN_BUDGET, jobTokens: 5 });
  });
});

// Part 5: the day budgets. What the user's jobs spent on one UTC day, in all and per repository, as the ledger's `day`
// group counts it (the day of a session's last counted message); a waiting job is held while a day cap is reached.
const entry = (jobId: string, last: string, o: Partial<TokenLedgerEntry> = {}): TokenLedgerEntry => ({
  jobId, session: `s-${jobId}`, model: 'claude-opus-5-5', readAt: last, last, turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...o,
});
const repos: Record<string, string> = { a: 'owner/a', b: 'owner/b' };

describe('the day budgets (issue #2302, part 5)', () => {
  const day = '2026-10-21';
  const spend = daySpendOf([
    entry('a', '2026-10-21T01:00:00.000Z', { output: 1000, cacheRead: 600 }),
    entry('b', '2026-10-21T23:59:59.000Z', { input: 400 }),
    entry('c', '2026-10-21T12:00:00.000Z', { input: 5 }),
    entry('a', '2026-10-20T23:59:59.000Z', { input: 1_000_000 }),
  ], day, (id) => repos[id]);

  it('sums the day\'s spend in all and per repository; other days do not count', () => {
    expect(spend.day).toBe(day);
    expect(spend.total.tokens).toBe(2005);
    expect(spend.repos['owner/a']!.tokens).toBe(1600);
    expect(spend.repos['owner/b']!.tokens).toBe(400);
    expect(spend.total.costUsd).toBeCloseTo(spend.repos['owner/a']!.costUsd + spend.repos['owner/b']!.costUsd + 5 * 4e-6, 9);
  });

  it('holds no job while the day caps are off', () => {
    expect(dayBudgetHold('owner/a', spend, DEFAULT_TOKEN_BUDGET)).toBeUndefined();
    expect(dayBudgetHold('owner/a', spend, { ...DEFAULT_TOKEN_BUDGET, jobTokens: 1 })).toBeUndefined();
  });

  it('holds every waiting job once the day\'s spend reaches the day cap, and says when it goes on', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, dayTokens: 2005 };
    const why = 'Held by the token budget: the jobs used the day\'s token budget of 2,005 tokens on 2026-10-21 (UTC). No job starts or goes on until the next UTC day, or until an admin raises the budget.';
    expect(dayBudgetHold('owner/a', spend, s)).toBe(why);
    expect(dayBudgetHold(undefined, spend, s)).toBe(why);
    expect(dayBudgetHold('owner/a', spend, { ...s, dayTokens: 2006 })).toBeUndefined();
    expect(dayBudgetHold('owner/a', spend, { ...DEFAULT_TOKEN_BUDGET, dayCostUsd: 0.02 })).toBe('Held by the token budget: the jobs used the day\'s cost budget of $0.02 on 2026-10-21 (UTC). No job starts or goes on until the next UTC day, or until an admin raises the budget.');
  });

  it('holds only the jobs of a repository whose day\'s spend reaches the repository cap', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, repoDayTokens: 1000 };
    expect(dayBudgetHold('owner/a', spend, s)).toBe('Held by the token budget: the jobs of owner/a used its day\'s token budget of 1,000 tokens on 2026-10-21 (UTC). No job of owner/a starts or goes on until the next UTC day, or until an admin raises the budget.');
    expect(dayBudgetHold('owner/b', spend, s)).toBeUndefined();
    expect(dayBudgetHold('owner/new', spend, s)).toBeUndefined();
    expect(dayBudgetHold(undefined, spend, s)).toBeUndefined();
    expect(dayBudgetHold('owner/b', spend, { ...DEFAULT_TOKEN_BUDGET, repoDayCostUsd: 0.0015 })).toMatch(/^Held by the token budget: the jobs of owner\/b used its day's cost budget of /);
  });
});
