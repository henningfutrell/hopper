// Gate clearances (issue #2554 part 5, design.md "Delivery forecasts"), pure: a person's act that ends a delivery gate
// for one promotion set, read from the delivery_gate.cleared events, and where it moves a change among the scheduled steps.
//
// Feature: gate clearances
//   Scenario: a clearance names a repository (any case), a set and a step; the first one of each step counts
//   Scenario: a clearance of another repository or another set does not count
//   Scenario: a cleared gate ends its step at the clearance, not before the step starts
//   Scenario: a cleared production gate delivers the change at the clearance
//   Scenario: a clearance of a step with no gate changes nothing: the step ends on its schedule
import { describe, expect, it } from 'vitest';
import { scheduledPlace } from '../../src/domain/delivery-forecast.ts';
import { gateClearancesOf } from '../../src/domain/delivery-gates.ts';
import type { PromotionSetSchedule } from '../../src/domain/promotion-sets.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

let seq = 0;
const cleared = (at: string, data: Record<string, unknown>): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type: 'delivery_gate.cleared', at, data: { repo: 'octo/shed', set: 7, by: 'owner', ...data } });

// Tuesdays and Thursdays at 14:00 in Chicago; set 7's cutoff is Thursday 2026-10-22 19:00 UTC.
const SCHEDULE: PromotionSetSchedule = {
  timeZone: 'America/Chicago', cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }],
  testGateAfterMinutes: 120, productionAfterMinutes: 1440, epoch: '2026-10-01T00:00:00.000Z', expedite: 'out_of_cadence',
};
const since = '2026-10-22T17:10:00.000Z';
const CUTOFF = '2026-10-22T19:00:00.000Z';

describe('gateClearancesOf', () => {
  it('a clearance of the repository in any case and the set counts; the first of each step wins', () => {
    const events = [
      cleared('2026-10-22T22:00:00.000Z', { repo: 'Octo/Shed', step: 'test_gate' }),
      cleared('2026-10-22T23:00:00.000Z', { step: 'test_gate', by: 'other' }),
      cleared('2026-10-23T09:00:00.000Z', { step: 'production' }),
    ];
    expect(gateClearancesOf(events, 'octo/shed', 7)).toEqual({
      test_gate: { by: 'owner', at: '2026-10-22T22:00:00.000Z' },
      production: { by: 'owner', at: '2026-10-23T09:00:00.000Z' },
    });
  });

  it('a clearance of another repository or another set does not count', () => {
    const events = [cleared('2026-10-22T22:00:00.000Z', { repo: 'octo/other', step: 'test_gate' }), cleared('2026-10-22T22:00:00.000Z', { set: 8, step: 'test_gate' })];
    expect(gateClearancesOf(events, 'octo/shed', 7)).toEqual({});
  });
});

describe('scheduledPlace with gate clearances', () => {
  const gates = { test_gate: { owner: 'release-owner' }, production: { owner: 'release-owner' } };

  it('a cleared test gate ends at the clearance; the change is in production since then', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, gates, '2026-10-23T01:00:00.000Z', { test_gate: '2026-10-22T23:30:00.000Z' }))
      .toEqual({ step: 'production', since: '2026-10-22T23:30:00.000Z' });
  });

  it('a clearance before the step starts ends it when it starts', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, { test_gate: gates.test_gate }, '2026-10-22T19:30:00.000Z', { test_gate: '2026-10-22T18:00:00.000Z' }))
      .toEqual({ step: 'production', since: CUTOFF });
  });

  it('before the cutoff, a cleared test gate does not move the change out of its set', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, gates, '2026-10-22T18:30:00.000Z', { test_gate: '2026-10-22T18:00:00.000Z' }))
      .toEqual({ step: 'promotion_set', since });
  });

  it('a cleared production gate delivers the change at the clearance', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, gates, '2026-10-23T12:00:00.000Z', { test_gate: '2026-10-22T22:00:00.000Z', production: '2026-10-23T10:00:00.000Z' }))
      .toEqual({ deliveredAt: '2026-10-23T10:00:00.000Z' });
  });

  it('a gated step with no clearance still holds the change', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, gates, '2026-10-25T00:00:00.000Z', { production: '2026-10-23T10:00:00.000Z' }))
      .toEqual({ step: 'test_gate', since: CUTOFF });
  });

  it('a clearance of a step with no gate changes nothing: the step ends on its schedule', () => {
    expect(scheduledPlace(SCHEDULE, { step: 'promotion_set', since }, {}, '2026-10-22T20:00:00.000Z', { test_gate: '2026-10-22T19:30:00.000Z' }))
      .toEqual({ step: 'test_gate', since: CUTOFF });
  });
});
