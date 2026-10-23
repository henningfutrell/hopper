// Delivery schedules (issue #2554 part 3, design.md "Delivery forecasts"), pure: a promotion set by its number, where a
// change or a set is among the scheduled steps at a time, and the delivery settings an admin changes.
//
// Feature: delivery schedules
//   Scenario: a promotion set by its number has the times of its cutoff, and the cutoff before it
//   Scenario: a scheduled step with no delivery gate ends at its scheduled end
//   Scenario: a step with a delivery gate holds the change until a person ends it
//   Scenario: past the end of production with no gate, the change is delivered
//   Scenario: a change of the delivery settings replaces or removes one repository and keeps the others
import { describe, expect, it } from 'vitest';
import { scheduledPlace } from '../../src/domain/delivery-forecast.ts';
import { patchDeliverySettings } from '../../src/domain/delivery-settings.ts';
import { promotionSetNumbered, promotionSetOf, type PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';

// Tuesdays and Thursdays at 14:00 in Chicago; set 1 is the cutoff of Thursday 2026-10-01.
const SCHEDULE: PromotionSetSchedule = {
  timeZone: 'America/Chicago',
  cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }],
  testGateAfterMinutes: 120,
  productionAfterMinutes: 1440,
  epoch: '2026-10-01T00:00:00.000Z',
  expedite: 'out_of_cadence',
};

describe('promotionSetNumbered', () => {
  it('set 7: the cutoff of Thursday 2026-10-22, opened at the cutoff of Tuesday 2026-10-20', () => {
    expect(promotionSetNumbered(SCHEDULE, 7)).toEqual({
      set: { set: 7, cutoffAt: '2026-10-22T19:00:00.000Z', testGateAt: '2026-10-22T21:00:00.000Z', productionAt: '2026-10-23T21:00:00.000Z' },
      opensAt: '2026-10-20T19:00:00.000Z',
    });
  });
  it('set 1 opens at the epoch', () => {
    expect(promotionSetNumbered(SCHEDULE, 1)?.opensAt).toBe('2026-10-01T00:00:00.000Z');
  });
  it('agrees with promotionSetOf, also across the end of daylight saving time', () => {
    for (const n of [1, 2, 9, 10, 11]) {
      const { set, opensAt } = promotionSetNumbered(SCHEDULE, n)!;
      expect(promotionSetOf(SCHEDULE, opensAt)).toEqual(set);
    }
  });
  it('set 0, a negative set or a schedule with no cutoff: none', () => {
    expect(promotionSetNumbered(SCHEDULE, 0)).toBeUndefined();
    expect(promotionSetNumbered(SCHEDULE, -1)).toBeUndefined();
    expect(promotionSetNumbered({ ...SCHEDULE, cutoffs: [] }, 1)).toBeUndefined();
  });
});

describe('scheduledPlace', () => {
  const since = '2026-10-22T17:10:00.000Z'; // landing checks ended; the cutoff is at 19:00
  it('before the cutoff: still in the promotion set', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, {}, '2026-10-22T18:00:00.000Z')).toEqual({ step: 'promotion_set', since });
  });
  it('past the cutoff with no gate: at the test gate since the cutoff', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, {}, '2026-10-22T19:30:00.000Z')).toEqual({ step: 'test_gate', since: '2026-10-22T19:00:00.000Z' });
  });
  it('a gated test gate holds the change past its end', () => {
    const gates = { test_gate: { owner: 'release-owner' } };
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, gates, '2026-10-25T12:00:00.000Z')).toEqual({ step: 'test_gate', since: '2026-10-22T19:00:00.000Z' });
  });
  it('past the end of production with no gate: delivered at that end', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, {}, '2026-10-24T00:00:00.000Z')).toEqual({ deliveredAt: '2026-10-23T21:00:00.000Z' });
  });
  it('a step that is not scheduled, or no schedule: the step as it is', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'coding', since }, {}, '2026-10-30T00:00:00.000Z')).toEqual({ step: 'coding', since });
    expect(scheduledPlace(undefined, { step: 'promotion_set', since }, {}, '2026-10-30T00:00:00.000Z')).toEqual({ step: 'promotion_set', since });
  });
  it('keeps the blocker of the change while it stays in its step', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'coding', since, blocker: 'conflict' }, {}, since)).toEqual({ step: 'coding', since, blocker: 'conflict' });
  });
});

describe('patchDeliverySettings', () => {
  const a = { schedule: SCHEDULE, gates: { test_gate: { owner: 'release-owner' } } };
  it('sets a repository, lowercased, and keeps the repositories in order', () => {
    expect(patchDeliverySettings({ repos: { 'z/z': { gates: {} } } }, { repos: { 'Octo/Identity': a } })).toEqual({ repos: { 'octo/identity': a, 'z/z': { gates: {} } } });
  });
  it('replaces a repository whole, and null removes it', () => {
    const s = { repos: { 'octo/identity': a, 'z/z': { gates: {} } } };
    expect(patchDeliverySettings(s, { repos: { 'octo/identity': { gates: {} }, 'z/z': null } })).toEqual({ repos: { 'octo/identity': { gates: {} } } });
  });
});
