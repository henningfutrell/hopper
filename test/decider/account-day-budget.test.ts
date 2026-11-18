// Issue #2966: an account day budget is a usage source's own cap on what its account's jobs spend in one UTC day, an
// estimated cost from the token ledger. It is a reading of window `day budget` that never stops a machine: below the cap
// it throttles nothing, at the cap or over it the jobs of its executors go to the soft lanes. Off unless set.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { dayBudgetReadings } from '../../src/domain/token-budget.ts';
import type { TokenLedgerEntry } from '../../src/domain/token-usage.ts';
import { inputs, job, machine, NOW, policy, reading } from './support.ts';

const one = machine({ id: 'm', maxLanes: 6, executors: ['claude'] });
const limits = { ...policy, softLimit: 0.7, hardLimit: 0.95, softLanes: 1 };
const budget = (used: number, limit = 20) => reading(used, limit, { source: 'claude-m', machineId: 'm', executors: ['claude'], window: 'day budget', unit: 'USD', dayBudget: true });

describe('account day budget in the decider (issue #2966)', () => {
  it('below the cap: every lane, even past the soft and hard limits of a usage window', () => {
    expect(laneEffect(one, [budget(19.5)], limits, NOW)).toMatchObject({ cap: 6, band: 'free', usedFrac: 0 });
  });

  it('at the cap or over it: the soft lanes, never 0', () => {
    expect(laneEffect(one, [budget(20)], limits, NOW)).toMatchObject({ cap: 1, band: 'soft', throttle: { source: 'claude-m', window: 'day budget', usedFrac: 1 } });
    expect(laneEffect(one, [budget(60)], limits, NOW)).toMatchObject({ cap: 1, band: 'soft' });
  });

  it('a usage window at its hard limit still stops the machine', () => {
    const week = reading(96, 100, { source: 'claude-m', machineId: 'm', executors: ['claude'], window: 'week' });
    expect(laneEffect(one, [budget(30), week], limits, NOW)).toMatchObject({ cap: 0, band: 'hard' });
  });

  it('it does not hide an unread usage source: the band stays unknown', () => {
    const unread = [{ source: 'other', machineId: 'm', executors: ['claude'] }];
    expect(laneEffect(one, [budget(5)], limits, NOW, unread)).toMatchObject({ cap: 1, band: 'unknown', unknown: ['other'] });
  });

  it('the decider starts only the soft lanes over the cap', () => {
    const d = decide(inputs({ machines: [one], usage: [budget(25)], policy: limits, waiting: [job('a', { executor: 'claude' }), job('b', { executor: 'claude' })] }), 'd1');
    expect(d.start).toHaveLength(1);
    expect(d.reasons).toContain('m: 0% used (day budget 125% spent), lane cap 1 of 6 (soft)');
  });
});

const row = (over: Partial<TokenLedgerEntry>): TokenLedgerEntry => ({
  jobId: 'j', session: 's', model: 'claude-opus-4-1', readAt: NOW, turns: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ...over,
});

describe('dayBudgetReadings (issue #2966)', () => {
  const day = NOW.slice(0, 10);
  const source = (over: object = {}) => ({ name: 'claude-m', state: { dayCostUsd: 10, executors: ['claude'], account: { service: 'claude', identity: 'a@x', detail: { machine: 'm' } } }, ...over });

  it('the account\'s spend today, across its machines, against the cap', () => {
    const rows = [row({ account: 'a@x', machineId: 'm' }), row({ account: 'a@x', machineId: 'n', session: 't' }), row({ account: 'b@x', machineId: 'm', session: 'u' }),
      row({ account: 'a@x', session: 'v', last: '2000-01-01T00:00:00.000Z' })];
    const [r] = dayBudgetReadings([source()], rows, NOW);
    expect(r).toMatchObject({ source: 'claude-m', machineId: 'm', executors: ['claude'], window: 'day budget', unit: 'USD', limit: 10, dayBudget: true, at: NOW });
    expect(r!.resetsAt).toBe(`${new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString()}`);
    // Two rows of the account today; the other account's and an older day's do not count.
    const each = dayBudgetReadings([source()], [rows[0]!], NOW)[0]!.used;
    expect(each).toBeGreaterThan(0);
    expect(r!.used).toBeCloseTo(2 * each, 2);
  });

  it('with no identity known, the machine\'s spend', () => {
    const rows = [row({ machineId: 'm' }), row({ machineId: 'n', session: 't' })];
    const s = source({ state: { dayCostUsd: 10, account: { service: 'claude', detail: { machine: 'm' } } } });
    const once = dayBudgetReadings([s], [rows[0]!], NOW)[0]!.used;
    expect(dayBudgetReadings([s], rows, NOW)[0]!.used).toBeCloseTo(once, 2);
  });

  it('no cap, a cap of 0, or no account read yet: no reading', () => {
    expect(dayBudgetReadings([source({ state: { account: { service: 'claude', identity: 'a@x', detail: { machine: 'm' } } } })], [], NOW)).toEqual([]);
    expect(dayBudgetReadings([source({ state: { dayCostUsd: 0, account: { service: 'claude', identity: 'a@x', detail: { machine: 'm' } } } })], [], NOW)).toEqual([]);
    expect(dayBudgetReadings([source({ state: { dayCostUsd: 5 } })], [], NOW)).toEqual([]);
  });
});
