// Delivery forecasts in the UI (issue #2554 part 7), pure: the times of a forecast shown in the owner's time zone (the
// repository's promotion set schedule's), the query a person's text names, and the gates of a promotion set a person can
// clear.
import { describe, expect, it } from 'vitest';
import type { DeliveryForecast } from '../../src/domain/delivery-forecast.ts';
import { changeQuery, durationText, forecastRows, gatesToClear, timeZoneOf, zonedTime } from '../../ui/src/model/delivery-forecast.ts';

describe('zonedTime', () => {
  it('the wall clock in the time zone, with its weekday', () => {
    expect(zonedTime('2026-10-22T19:00:00.000Z', 'America/Chicago')).toBe('Thu 22 Oct 14:00');
    expect(zonedTime('2026-10-22T19:00:00.000Z', 'UTC')).toBe('Thu 22 Oct 19:00');
    // After the end of daylight saving time in Chicago (1 November), UTC-6.
    expect(zonedTime('2026-11-02T00:30:00.000Z', 'America/Chicago')).toBe('Sun 1 Nov 18:30');
  });
});

describe('durationText', () => {
  it('days, hours and minutes, the two largest', () => {
    expect(durationText(0)).toBe('0 min');
    expect(durationText(5 * 60_000)).toBe('5 min');
    expect(durationText(125 * 60_000)).toBe('2 h 5 min');
    expect(durationText((26 * 60 + 7) * 60_000)).toBe('1 d 2 h');
  });
});

describe('timeZoneOf', () => {
  const settings = { repos: { 'octo/shed': { gates: {}, schedule: { timeZone: 'America/Chicago', cutoffs: [], testGateAfterMinutes: 1, productionAfterMinutes: 1, epoch: '2026-10-01T00:00:00.000Z', expedite: 'none' as const } } } };
  it("the repository's schedule time zone, any case; else the fallback", () => {
    expect(timeZoneOf(settings, 'Octo/Shed', 'UTC')).toBe('America/Chicago');
    expect(timeZoneOf(settings, 'octo/other', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(timeZoneOf(settings, undefined, 'UTC')).toBe('UTC');
  });
});

describe('changeQuery', () => {
  it('an issue, a pull request URL, else a job id', () => {
    expect(changeQuery(' octo/shed#7 ')).toBe('issue=octo%2Fshed%237');
    expect(changeQuery('https://github.com/octo/shed/pull/12')).toBe('pr=https%3A%2F%2Fgithub.com%2Focto%2Fshed%2Fpull%2F12');
    expect(changeQuery('8f1c2d')).toBe('job=8f1c2d');
    expect(changeQuery('  ')).toBeUndefined();
  });
});

const forecast: DeliveryForecast = {
  now: '2026-10-22T19:00:00.000Z', step: 'promotion_set', since: '2026-10-22T18:00:00.000Z',
  wait: { kind: 'human_gate', owner: 'release-owner', since: '2026-10-22T18:00:00.000Z' },
  normal: {
    steps: [
      { step: 'promotion_set', basis: 'scheduled', start: '2026-10-22T18:00:00.000Z', end: '2026-10-22T19:00:00.000Z', endP90: '2026-10-22T19:00:00.000Z', set: 7, setP90: 7, gate: { owner: 'release-owner' } },
      { step: 'test_gate', basis: 'scheduled', start: '2026-10-22T19:00:00.000Z', end: '2026-10-22T21:00:00.000Z', endP90: '2026-10-22T21:00:00.000Z', set: 7, setP90: 8 },
      { step: 'production', basis: 'unknown' },
    ],
  },
};

describe('forecastRows', () => {
  it('each step left, its times in the zone, its set, its basis and its gate', () => {
    expect(forecastRows(forecast, 'America/Chicago')).toEqual([
      { step: 'promotion_set', label: 'Promotion set', current: true, start: 'Thu 22 Oct 13:00', end: 'Thu 22 Oct 14:00', endP90: 'Thu 22 Oct 14:00', set: 'set 7', basis: 'scheduled', gate: 'release-owner' },
      { step: 'test_gate', label: 'Test gate', current: false, start: 'Thu 22 Oct 14:00', end: 'Thu 22 Oct 16:00', endP90: 'Thu 22 Oct 16:00', set: 'set 7 (p90: 8)', basis: 'scheduled' },
      { step: 'production', label: 'Production', current: false, basis: 'too little history' },
    ]);
  });
  it('a measured step names its sample size', () => {
    const f: DeliveryForecast = { ...forecast, step: 'coding', normal: { steps: [{ step: 'coding', basis: 'measured', samples: 12, start: forecast.now, end: forecast.now, endP90: forecast.now }] } };
    expect(forecastRows(f, 'UTC')[0]).toMatchObject({ label: 'Coding', basis: 'measured, 12 samples' });
  });
});

describe('gatesToClear', () => {
  it('the gated steps of the steps left', () => {
    expect(gatesToClear(forecast)).toEqual([{ step: 'promotion_set', owner: 'release-owner' }]);
    expect(gatesToClear(undefined)).toEqual([]);
  });
});
