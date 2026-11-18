// Daily usage from the Claude Enterprise Analytics API (issue #2966, glossary "Daily usage") as the Usage page writes it:
// one account's day in short words. Pure.
import { tokenCount } from './token-ledger.ts';
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
