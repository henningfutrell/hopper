// Forecast accuracy (issue #2554, design.md "Delivery forecasts"), pure: the delivery ledger of one change — the
// predicted and the actual start and end of each step — and the mean absolute error of the predicted ends, per step and
// per repository.
//
// Feature: forecast accuracy
//   Scenario: a change run end to end has a ledger row with predicted and actual times for every step
//   Scenario: the accuracy report is the mean absolute error of the ends, per step and per repository
//   Scenario: a row with no prediction or no actual end is not counted
//   Scenario: the error over time, per day or per week of the actual end in the owner's time zone (part 7)
import { describe, expect, it } from 'vitest';
import { deliveryForecast } from '../../src/domain/delivery-forecast.ts';
import { DELIVERY_STEPS } from '../../src/domain/delivery-steps.ts';
import { accuracyOverTime, deliveryLedger, forecastAccuracy, type DeliveryLedgerRow, type StepActual } from '../../src/domain/forecast-accuracy.ts';

const MIN = 60_000;
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => m * MIN);
const at = (hhmm: string, day = 22) => `2026-10-${day}T${hhmm}:00.000Z`;

describe('a change run end to end', () => {
  // Predicted when the change was queued at 15:55; what then happened, step by step.
  const predicted = deliveryForecast({
    now: at('15:55'),
    current: { step: 'queued', since: at('15:55') },
    history: { queued: ten, coding: ten.map((m) => m * 10), pr_checks: ten, landing: ten, landing_checks: ten.map((m) => m * 2) },
    schedule: {
      timeZone: 'America/Chicago', cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }],
      testGateAfterMinutes: 120, productionAfterMinutes: 1440, epoch: '2026-10-01T00:00:00.000Z', expedite: 'none',
    },
    gates: { test_gate: { owner: 'release-owner' }, production: { owner: 'release-owner' } },
  }).normal;
  const actuals: StepActual[] = [
    { step: 'queued', start: at('15:55'), end: at('16:02') },
    { step: 'coding', start: at('16:02'), end: at('17:02') },
    { step: 'pr_checks', start: at('17:02'), end: at('17:08') },
    { step: 'landing', start: at('17:08'), end: at('17:10') },
    { step: 'landing_checks', start: at('17:10'), end: at('17:30') },
    { step: 'promotion_set', start: at('17:30'), end: at('19:00') },
    { step: 'test_gate', start: at('19:00'), end: at('21:30') },
    { step: 'production', start: at('21:30'), end: at('21:00', 23) },
  ];
  const rows = deliveryLedger('henningfutrell/hopper', 'job:1', predicted, actuals);

  it('the ledger holds predicted and actual times for every step', () => {
    expect(rows.map((r) => r.step)).toEqual([...DELIVERY_STEPS]);
    for (const r of rows) {
      for (const k of ['predictedStart', 'predictedEnd', 'actualStart', 'actualEnd'] as const) expect(r[k], `${r.step} ${k}`).toBeDefined();
    }
    expect(rows[1]).toEqual({
      repo: 'henningfutrell/hopper', key: 'job:1', step: 'coding',
      predictedStart: at('16:00'), predictedEnd: at('16:50'), actualStart: at('16:02'), actualEnd: at('17:02'),
    });
  });

  it('the accuracy report: mean absolute error of the predicted ends', () => {
    // Predicted ends: 16:00, 16:50, 16:55, 17:00, 17:10, 19:00, 21:00, 23rd 21:00.
    expect(forecastAccuracy(rows)).toEqual({
      byStep: [
        { step: 'queued', samples: 1, meanAbsErrorMs: 2 * MIN },
        { step: 'coding', samples: 1, meanAbsErrorMs: 12 * MIN },
        { step: 'pr_checks', samples: 1, meanAbsErrorMs: 13 * MIN },
        { step: 'landing', samples: 1, meanAbsErrorMs: 10 * MIN },
        { step: 'landing_checks', samples: 1, meanAbsErrorMs: 20 * MIN },
        { step: 'promotion_set', samples: 1, meanAbsErrorMs: 0 },
        { step: 'test_gate', samples: 1, meanAbsErrorMs: 30 * MIN },
        { step: 'production', samples: 1, meanAbsErrorMs: 0 },
      ],
      byRepo: expect.any(Array),
    });
  });
});

describe('forecastAccuracy', () => {
  const row = (repo: string, predictedEnd: string | undefined, actualEnd: string | undefined): DeliveryLedgerRow =>
    ({ repo, key: `pr:${repo}`, step: 'pr_checks', predictedStart: at('10:00'), actualStart: at('10:00'), predictedEnd, actualEnd });
  it('per step and per repository; a row with no prediction or no actual end is not counted', () => {
    expect(forecastAccuracy([
      row('b/two', at('10:10'), at('10:20')),
      row('a/one', at('10:10'), at('10:14')),
      row('a/one', at('10:10'), at('10:08')),
      row('a/one', undefined, at('10:30')),
      row('a/one', at('10:10'), undefined),
    ])).toEqual({
      byStep: [{ step: 'pr_checks', samples: 3, meanAbsErrorMs: ((10 + 4 + 2) / 3) * MIN }],
      byRepo: [
        { repo: 'a/one', step: 'pr_checks', samples: 2, meanAbsErrorMs: 3 * MIN },
        { repo: 'b/two', step: 'pr_checks', samples: 1, meanAbsErrorMs: 10 * MIN },
      ],
    });
  });
});

describe('accuracyOverTime (part 7)', () => {
  const row = (step: DeliveryLedgerRow['step'], predictedEnd: string | undefined, actualEnd: string | undefined): DeliveryLedgerRow =>
    ({ repo: 'a/one', key: `job:${actualEnd}`, step, predictedEnd, actualEnd });
  // Chicago is UTC-5 in October: 04:00 UTC on the 23rd is 23:00 on the 22nd there.
  const rows = [
    row('coding', at('10:00', 22), at('10:10', 22)),
    row('coding', at('04:00', 23), at('04:20', 23)),
    row('pr_checks', at('15:00', 23), at('15:04', 23)),
    row('coding', at('12:00', 26), at('12:06', 26)),
    row('coding', undefined, at('12:00', 26)),
  ];
  it('per day of the actual end in the time zone, then per step', () => {
    expect(accuracyOverTime(rows, 'day', 'America/Chicago')).toEqual({
      period: 'day', timeZone: 'America/Chicago',
      points: [
        { start: '2026-10-22', step: 'coding', samples: 2, meanAbsErrorMs: 15 * MIN },
        { start: '2026-10-23', step: 'pr_checks', samples: 1, meanAbsErrorMs: 4 * MIN },
        { start: '2026-10-26', step: 'coding', samples: 1, meanAbsErrorMs: 6 * MIN },
      ],
    });
    expect(accuracyOverTime(rows, 'day', 'UTC').points.map((p) => p.start)).toEqual(['2026-10-22', '2026-10-23', '2026-10-23', '2026-10-26']);
  });
  it('per week, from its Monday', () => {
    // 2026-10-22 is a Thursday: its week starts on Monday the 19th; the 26th is the next Monday.
    expect(accuracyOverTime(rows, 'week', 'America/Chicago').points).toEqual([
      { start: '2026-10-19', step: 'coding', samples: 2, meanAbsErrorMs: 15 * MIN },
      { start: '2026-10-19', step: 'pr_checks', samples: 1, meanAbsErrorMs: 4 * MIN },
      { start: '2026-10-26', step: 'coding', samples: 1, meanAbsErrorMs: 6 * MIN },
    ]);
  });
  it('the same rows give the same output', () => {
    expect(accuracyOverTime([...rows].reverse(), 'week', 'UTC')).toEqual(accuracyOverTime(rows, 'week', 'UTC'));
  });
});
