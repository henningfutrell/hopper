// Promotion sets (issue #2554, design.md "Delivery forecasts"), pure: the set a merge lands in, from the schedule's
// cutoffs in its time zone, and when that set is expected at the test gate and in production.
//
// Feature: promotion sets
//   Scenario: a merge just before a cutoff lands in that cutoff's set
//   Scenario: a merge exactly at a cutoff, or just after it, lands in the next set
//   Scenario: a merge late in the day lands in the set of the next cutoff day
//   Scenario: a cutoff after the end of daylight saving time keeps its wall-clock time
//   Scenario: a schedule with no cutoff, or a time before the epoch, has no set
import { describe, expect, it } from 'vitest';
import { promotionSetOf, type PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';

// Tuesdays and Thursdays at 14:00 in Chicago; set 1 is the cutoff of Thursday 2026-10-01.
const SCHEDULE: PromotionSetSchedule = {
  timeZone: 'America/Chicago',
  cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }],
  testGateAfterMinutes: 120,
  productionAfterMinutes: 1440,
  epoch: '2026-10-01T00:00:00.000Z',
  expedite: 'out_of_cadence',
};

describe('promotionSetOf', () => {
  it('just before the cutoff of Thursday 2026-10-22: set 7', () => {
    expect(promotionSetOf(SCHEDULE, '2026-10-22T18:59:59.000Z')).toEqual({
      set: 7, cutoffAt: '2026-10-22T19:00:00.000Z', testGateAt: '2026-10-22T21:00:00.000Z', productionAt: '2026-10-23T21:00:00.000Z',
    });
  });
  it('exactly at the cutoff: the next set', () => {
    expect(promotionSetOf(SCHEDULE, '2026-10-22T19:00:00.000Z')).toMatchObject({ set: 8, cutoffAt: '2026-10-27T19:00:00.000Z' });
  });
  it('just after the cutoff: the next set', () => {
    expect(promotionSetOf(SCHEDULE, '2026-10-22T19:00:01.000Z')).toMatchObject({ set: 8, cutoffAt: '2026-10-27T19:00:00.000Z' });
  });
  it('23:30 in Chicago, already the next day in UTC: the set of the next cutoff day', () => {
    expect(promotionSetOf(SCHEDULE, '2026-10-23T04:30:00.000Z')).toMatchObject({ set: 8, cutoffAt: '2026-10-27T19:00:00.000Z' });
  });
  it('daylight saving time ends 2026-11-01: 14:00 in Chicago is 20:00 UTC after it', () => {
    expect(promotionSetOf(SCHEDULE, '2026-10-30T12:00:00.000Z')).toEqual({
      set: 10, cutoffAt: '2026-11-03T20:00:00.000Z', testGateAt: '2026-11-03T22:00:00.000Z', productionAt: '2026-11-04T22:00:00.000Z',
    });
  });
  it('a schedule with no cutoff, or a time before the epoch: no set', () => {
    expect(promotionSetOf({ ...SCHEDULE, cutoffs: [] }, '2026-10-22T12:00:00.000Z')).toBeUndefined();
    expect(promotionSetOf(SCHEDULE, '2026-09-30T12:00:00.000Z')).toBeUndefined();
  });
});
