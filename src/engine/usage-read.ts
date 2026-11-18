// One read of every usage source (issue #2919): its readings, and the sources that gave none and say why (`unreadUsage`),
// so the decider, the usage report and lane tuning take usage they cannot read as unknown, never as 0%.
import { unreadUsageOf } from '../decider/usage.ts';
import { dayBudgetReadings, dayBudgetsOn } from '../domain/token-budget.ts';
import type { UnreadUsage, UsageReading } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface UsageRead { readings: UsageReading[]; unread: UnreadUsage[] }

/**
 * Every usage source's readings, and (issue #2966) each one's account day budget reading: the token ledger is read only
 * while a source has one on, and only for the day of the clock.
 */
export async function readUsage(c: Pick<EngineContext, 'usage' | 'store' | 'clock'>): Promise<UsageRead> {
  const sources = c.usage();
  const each = await Promise.all(sources.map((u) => u.poll()));
  const states = sources.map((u) => ({ name: u.name, state: u.state?.() }));
  const at = c.clock.now().toISOString();
  const budgets = dayBudgetsOn(states.map((s) => s.state))
    ? dayBudgetReadings(states, c.store.tokenLedger.list({ since: `${at.slice(0, 10)}T00:00:00.000Z` }), at)
    : [];
  return {
    readings: [...each.flat(), ...budgets],
    unread: unreadUsageOf(states.map((s, i) => ({ ...s, readings: each[i]! }))),
  };
}
