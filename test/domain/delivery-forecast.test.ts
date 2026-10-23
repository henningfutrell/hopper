// Delivery forecasts (issue #2554, design.md "Delivery forecasts"), pure: where a change is on its way to production,
// and when it is expected at each step left, from measured step durations and the promotion sets.
//
// Feature: delivery forecasts
//   Scenario: a change at work: every step left has a start, an end at p50 and an end at p90, in order
//   Scenario: too little history for a step: it says so, and no later time is given
//   Scenario: expedite skips the cadence wait; both paths are shown, and the expedited one is never later
//   Scenario: past its p90 a step is slipping, with a blocker, and the later steps are forecast again
//   Scenario: a change at a delivery gate waits on its owner; the person's wait is apart from machine time
//   Scenario: with no promotion set schedule, the scheduled steps are unknown
//   Scenario: the same inputs give the same forecast
import { describe, expect, it } from 'vitest';
import { deliveryForecast, type ForecastInput } from '../../src/domain/delivery-forecast.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';

const MIN = 60_000;
const minutes = (...m: number[]) => m.map((x) => x * MIN);
const ONE_TO_TEN = minutes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);

const SCHEDULE: PromotionSetSchedule = {
  timeZone: 'America/Chicago',
  cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }],
  testGateAfterMinutes: 120,
  productionAfterMinutes: 1440,
  epoch: '2026-10-01T00:00:00.000Z',
  expedite: 'out_of_cadence',
};

const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  now: '2026-10-22T16:10:00.000Z',
  current: { step: 'coding', since: '2026-10-22T16:00:00.000Z' },
  history: {
    queued: ONE_TO_TEN,
    coding: ONE_TO_TEN.map((m) => m * 10),
    pr_checks: ONE_TO_TEN,
    landing: ONE_TO_TEN,
    landing_checks: ONE_TO_TEN.map((m) => m * 2),
  },
  schedule: SCHEDULE,
  gates: { test_gate: { owner: 'release-owner' }, production: { owner: 'release-owner' } },
  ...over,
});

const ends = (f: ReturnType<typeof deliveryForecast>['normal']) => f.steps.map((s) => s.end);

describe('deliveryForecast', () => {
  it('a change at work: each step left, in order, with p50 and p90 ends', () => {
    expect(deliveryForecast(input())).toEqual({
      now: '2026-10-22T16:10:00.000Z',
      step: 'coding',
      since: '2026-10-22T16:00:00.000Z',
      normal: {
        steps: [
          { step: 'coding', basis: 'measured', samples: 10, start: '2026-10-22T16:00:00.000Z', end: '2026-10-22T16:50:00.000Z', endP90: '2026-10-22T17:30:00.000Z' },
          { step: 'pr_checks', basis: 'measured', samples: 10, start: '2026-10-22T16:50:00.000Z', end: '2026-10-22T16:55:00.000Z', endP90: '2026-10-22T17:39:00.000Z' },
          { step: 'landing', basis: 'measured', samples: 10, start: '2026-10-22T16:55:00.000Z', end: '2026-10-22T17:00:00.000Z', endP90: '2026-10-22T17:48:00.000Z' },
          { step: 'landing_checks', basis: 'measured', samples: 10, start: '2026-10-22T17:00:00.000Z', end: '2026-10-22T17:10:00.000Z', endP90: '2026-10-22T18:06:00.000Z' },
          { step: 'promotion_set', basis: 'scheduled', start: '2026-10-22T17:10:00.000Z', end: '2026-10-22T19:00:00.000Z', endP90: '2026-10-22T19:00:00.000Z', set: 7, setP90: 7 },
          { step: 'test_gate', basis: 'scheduled', start: '2026-10-22T19:00:00.000Z', end: '2026-10-22T21:00:00.000Z', endP90: '2026-10-22T21:00:00.000Z', gate: { owner: 'release-owner' } },
          { step: 'production', basis: 'scheduled', start: '2026-10-22T21:00:00.000Z', end: '2026-10-23T21:00:00.000Z', endP90: '2026-10-23T21:00:00.000Z', gate: { owner: 'release-owner' } },
        ],
        productionAt: '2026-10-23T21:00:00.000Z',
        productionAtP90: '2026-10-23T21:00:00.000Z',
        remaining: { machineMs: 60 * MIN, scheduleMs: 110 * MIN, humanMs: 1560 * MIN },
      },
    });
  });

  it('a later step never starts or ends before the step before it', () => {
    for (const [step, since] of [['queued', '16:00'], ['pr_checks', '15:00'], ['landing_checks', '15:50'], ['promotion_set', '16:05']] as const) {
      const f = deliveryForecast(input({ current: { step, since: `2026-10-22T${since}:00.000Z` } }));
      f.normal.steps.forEach((s, i) => {
        expect(Date.parse(s.end!)).toBeGreaterThanOrEqual(Date.parse(s.start!));
        expect(Date.parse(s.endP90!)).toBeGreaterThanOrEqual(Date.parse(s.end!));
        if (i > 0) expect(s.start).toBe(f.normal.steps[i - 1]!.end);
      });
    }
  });

  it('too little history for coding: no end for it, and no later time', () => {
    const f = deliveryForecast(input({ history: { ...input().history, coding: minutes(30, 40) } }));
    expect(f.normal.steps[0]).toEqual({ step: 'coding', basis: 'unknown', samples: 2, start: '2026-10-22T16:00:00.000Z' });
    expect(f.normal.steps.slice(1).every((s) => s.basis === 'unknown' && s.start === undefined && s.end === undefined)).toBe(true);
    expect(f.normal.productionAt).toBeUndefined();
    expect(f.normal.remaining).toBeUndefined();
  });

  it('expedite: no cadence wait, both paths shown, the expedited one never later', () => {
    const f = deliveryForecast(input({ expedite: true }));
    expect(f.normal.productionAt).toBe('2026-10-23T21:00:00.000Z');
    expect(f.expedited?.steps[4]).toEqual({
      step: 'promotion_set', basis: 'scheduled', start: '2026-10-22T17:10:00.000Z', end: '2026-10-22T17:10:00.000Z', endP90: '2026-10-22T18:06:00.000Z', outOfCadence: true,
    });
    expect(f.expedited?.productionAt).toBe('2026-10-23T19:10:00.000Z');
    expect(Date.parse(f.expedited!.productionAt!)).toBeLessThanOrEqual(Date.parse(f.normal.productionAt!));
    expect(f.expedited?.remaining?.scheduleMs).toBe(0);
  });

  it('expedite where the schedule allows no out-of-cadence set: the same path as the normal one', () => {
    const f = deliveryForecast(input({ expedite: true, schedule: { ...SCHEDULE, expedite: 'none' } }));
    expect(f.expedited).toEqual(f.normal);
  });

  it('no expedite: no expedited path', () => {
    expect(deliveryForecast(input())).not.toHaveProperty('expedited');
  });

  it('past its p90, coding is slipping and the later steps move: here into the next set', () => {
    expect(deliveryForecast(input({ now: '2026-10-22T17:20:00.000Z' }))).not.toHaveProperty('slipping');
    const late = deliveryForecast(input({ now: '2026-10-22T18:45:00.000Z' }));
    expect(late.slipping).toEqual({ blocker: 'queue', expectedEnd: '2026-10-22T17:30:00.000Z' });
    expect(late.normal.steps[0]!.end).toBe('2026-10-22T18:45:00.000Z');
    expect(late.normal.steps[4]).toMatchObject({ step: 'promotion_set', start: '2026-10-22T19:05:00.000Z', set: 8, end: '2026-10-27T19:00:00.000Z' });
    expect(late.normal.productionAt).toBe('2026-10-28T21:00:00.000Z');
  });

  it('the blocker is the step default, unless the change names one', () => {
    const at = { now: '2026-10-22T16:30:00.000Z' };
    expect(deliveryForecast(input({ ...at, current: { step: 'pr_checks', since: '2026-10-22T16:00:00.000Z' } })).slipping?.blocker).toBe('ci_red');
    expect(deliveryForecast(input({ ...at, current: { step: 'pr_checks', since: '2026-10-22T16:00:00.000Z', blocker: 'conflict' } })).slipping?.blocker)
      .toBe('conflict');
    expect(deliveryForecast(input({ ...at, current: { step: 'queued', since: '2026-10-22T16:00:00.000Z' } })).slipping?.blocker).toBe('queue');
  });

  it('at the test gate: a wait on its owner, the person\'s wait apart from machine time', () => {
    const f = deliveryForecast(input({ now: '2026-10-22T20:00:00.000Z', current: { step: 'test_gate', since: '2026-10-22T19:00:00.000Z' } }));
    expect(f.wait).toEqual({ kind: 'human_gate', owner: 'release-owner', since: '2026-10-22T19:00:00.000Z' });
    expect(f.normal.remaining).toEqual({ machineMs: 0, scheduleMs: 0, humanMs: (60 + 1440) * MIN });
    expect(f).not.toHaveProperty('slipping');
    const late = deliveryForecast(input({ now: '2026-10-22T21:30:00.000Z', current: { step: 'test_gate', since: '2026-10-22T19:00:00.000Z' } }));
    expect(late.slipping).toEqual({ blocker: 'human_gate', expectedEnd: '2026-10-22T21:00:00.000Z' });
    expect(ends(late.normal)).toEqual(['2026-10-22T21:30:00.000Z', '2026-10-23T21:30:00.000Z']);
  });

  it('with no promotion set schedule (part 2), the scheduled steps are unknown and give no time', () => {
    const f = deliveryForecast(input({ schedule: undefined, current: { step: 'landing_checks', since: '2026-10-22T16:00:00.000Z' }, expedite: true }));
    expect(f.normal.steps.map((s) => [s.step, s.basis])).toEqual([
      ['landing_checks', 'measured'], ['promotion_set', 'unknown'], ['test_gate', 'unknown'], ['production', 'unknown'],
    ]);
    expect(f.normal.productionAt).toBeUndefined();
    expect(f.expedited).toEqual(f.normal);
  });

  it('the same inputs give the same forecast', () => {
    const a = deliveryForecast(input({ expedite: true, now: '2026-10-22T18:45:00.000Z' }));
    const b = deliveryForecast(input({ expedite: true, now: '2026-10-22T18:45:00.000Z' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
