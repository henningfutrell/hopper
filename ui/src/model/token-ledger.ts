// The token ledger's words (issue #2302): token counts and an estimated cost as a person reads them. Pure.
import type { TokenTotals } from '@/model/wire';

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
