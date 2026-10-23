// The delivery ledger's actual times of the scheduled steps (issue #2554 part 6, design.md "Delivery forecasts"), pure: from
// the end of a change's landing checks, when its promotion set step, test gate and production actually started and ended,
// by its promotion set schedule and its set's gate clearances.
//
// Feature: the scheduled steps' actual times
//   Scenario: an ungated step ends at its scheduled end
//   Scenario: a gated step has no end until a person clears it, then it ends at the clearance
//   Scenario: with no schedule, only the start of the promotion set step is known
import { describe, expect, it } from 'vitest';
import { scheduledActuals, scheduledPlace } from '../../src/domain/delivery-forecast.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';

// A cutoff each day at 00:00 UTC; the test gate an hour after it, production an hour after that.
const SCHEDULE: PromotionSetSchedule = {
  timeZone: 'UTC', cutoffs: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, time: '00:00' })), testGateAfterMinutes: 60,
  productionAfterMinutes: 60, epoch: '2026-10-01T00:00:00.000Z', expedite: 'out_of_cadence',
};
const LANDED = { step: 'promotion_set' as const, since: '2026-10-20T10:00:00.000Z' };

describe('scheduledActuals', () => {
  it('ungated: each step ends at its scheduled end, and the step in progress has no end', () => {
    expect(scheduledActuals(SCHEDULE, LANDED, {}, '2026-10-21T00:30:00.000Z')).toEqual([
      { step: 'promotion_set', start: '2026-10-20T10:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      { step: 'test_gate', start: '2026-10-21T00:00:00.000Z' },
    ]);
    expect(scheduledActuals(SCHEDULE, LANDED, {}, '2026-10-21T03:00:00.000Z')).toEqual([
      { step: 'promotion_set', start: '2026-10-20T10:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      { step: 'test_gate', start: '2026-10-21T00:00:00.000Z', end: '2026-10-21T01:00:00.000Z' },
      { step: 'production', start: '2026-10-21T01:00:00.000Z', end: '2026-10-21T02:00:00.000Z' },
    ]);
  });

  it('a gated step holds until its clearance, then ends there', () => {
    const gates = { test_gate: { owner: 'release-owner' } };
    expect(scheduledActuals(SCHEDULE, LANDED, gates, '2026-10-23T00:00:00.000Z')).toEqual([
      { step: 'promotion_set', start: '2026-10-20T10:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      { step: 'test_gate', start: '2026-10-21T00:00:00.000Z' },
    ]);
    expect(scheduledActuals(SCHEDULE, LANDED, gates, '2026-10-23T00:00:00.000Z', { test_gate: '2026-10-21T05:00:00.000Z' })).toEqual([
      { step: 'promotion_set', start: '2026-10-20T10:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      { step: 'test_gate', start: '2026-10-21T00:00:00.000Z', end: '2026-10-21T05:00:00.000Z' },
      { step: 'production', start: '2026-10-21T05:00:00.000Z', end: '2026-10-21T06:00:00.000Z' },
    ]);
  });

  it('agrees with scheduledPlace: the last step with no end is where the change is, else it is delivered', () => {
    for (const now of ['2026-10-20T11:00:00.000Z', '2026-10-21T00:30:00.000Z', '2026-10-21T01:30:00.000Z', '2026-10-21T03:00:00.000Z']) {
      const last = scheduledActuals(SCHEDULE, LANDED, {}, now).at(-1)!;
      expect(scheduledPlace(SCHEDULE, LANDED, {}, now)).toEqual(last.end ? { deliveredAt: last.end } : { step: last.step, since: last.start });
    }
  });

  it('with no schedule, only the start of the promotion set step', () => {
    expect(scheduledActuals(undefined, LANDED, {}, '2026-10-23T00:00:00.000Z')).toEqual([{ step: 'promotion_set', start: LANDED.since }]);
  });
});
