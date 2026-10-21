// Waste signals (issue #2302, part 4, design.md "The token ledger"): a job that spends tokens with no progress is flagged —
// many turns with no commit or push, repeated failing local test runs, a resume loop, cache-write churn —, and tokens per
// merged pull request is the efficiency number. Signals only: nothing is paused or stopped for one. Pure.
import type { TokenTotals } from './token-usage.ts';

/** The thresholds of the waste signals. */
export const WASTE = {
  /** Assistant messages with no commit and no push. */
  noProgressTurns: 150,
  /** Local test runs that failed. */
  failingTests: 5,
  /** Claims of the job: its first start, then each resume or start again. */
  resumeLoopAttempts: 5,
  /** Cache-write churn: at least this many tokens written to the cache… */
  churnTokens: 2_000_000,
  /** …and at least this share of what went through the cache written, not read back. */
  churnShare: 0.25,
} as const;

export const WASTE_KINDS = ['no_progress', 'failing_tests', 'resume_loop', 'cache_churn'] as const;
export type TokenWasteKind = (typeof WASTE_KINDS)[number];

/** One waste signal of a job: its kind and why, in words a person reads. */
export interface TokenWaste { kind: TokenWasteKind; why: string }

/** What a job did besides spend: its pushes through the hopper, the commits of its last checkpoint, its claims. */
export interface JobProgressFacts { pushes: number; commits: number; attempts: number }

/** A job the rollup flags (`GET /api/usage/tokens` `waste`): its waste signals, its totals, its title and repository. */
export type TokenWasteLine = TokenTotals & { jobId: string; title?: string; repo?: string; signals: TokenWaste[] };

const count = (n: number): string => Math.round(n).toLocaleString('en-US');

/** The waste signals of a job's token use, in the order of `WASTE_KINDS`; none for a job that makes progress. */
export function tokenWaste(t: TokenTotals, p: JobProgressFacts): TokenWaste[] {
  const out: TokenWaste[] = [];
  if (t.turns >= WASTE.noProgressTurns && p.pushes === 0 && p.commits === 0) out.push({ kind: 'no_progress', why: `${count(t.turns)} turns with no commit and no push.` });
  if ((t.failedTests ?? 0) >= WASTE.failingTests) out.push({ kind: 'failing_tests', why: `${count(t.failedTests!)} test runs failed.` });
  if (p.attempts >= WASTE.resumeLoopAttempts) out.push({ kind: 'resume_loop', why: `Started ${count(p.attempts)} times: it resumed or started again many times.` });
  const through = t.cacheRead + t.cacheWrite;
  if (t.cacheWrite >= WASTE.churnTokens && t.cacheWrite >= through * WASTE.churnShare) {
    out.push({ kind: 'cache_churn', why: `${count(t.cacheWrite)} tokens written to the cache, ${Math.round((t.cacheWrite / through) * 100)}% of what went through it: the cache was written again and again.` });
  }
  return out;
}

/** Tokens per merged pull request: every token and the estimated cost, divided by the pull requests merged; none when none was. */
export interface PerMergedPullRequest { pullRequests: number; tokens?: number; costUsd?: number }

export function perMergedPullRequest(t: TokenTotals, merged: number): PerMergedPullRequest {
  if (merged <= 0) return { pullRequests: 0 };
  return { pullRequests: merged, tokens: (t.input + t.output + t.cacheRead + t.cacheWrite) / merged, costUsd: t.costUsd / merged };
}
