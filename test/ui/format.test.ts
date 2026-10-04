// How the UI writes times: durations, ages, countdowns.
import { describe, expect, it } from 'vitest';
import { ago, between, countdown, duration, elapsed } from '../../ui/src/model/format.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const before = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('format', () => {
  it('duration: seconds, then minutes and seconds, then hours and minutes', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59.9)).toBe('59s');
    expect(duration(61)).toBe('1m 1s');
    expect(duration(3600 + 120 + 5)).toBe('1h 2m');
    expect(duration(-5)).toBe('0s');
  });
  it('elapsed and between measure from ISO times', () => {
    expect(elapsed(before(90), NOW)).toBe('1m 30s');
    expect(between(before(30), before(0))).toBe('30s');
    expect(between(undefined, before(0))).toBe('');
  });
  it('ago: never, seconds, minutes, hours, days', () => {
    expect(ago(undefined, NOW)).toBe('never');
    expect(ago(before(5), NOW)).toBe('5s ago');
    expect(ago(before(125), NOW)).toBe('2m ago');
    expect(ago(before(7300), NOW)).toBe('2h ago');
    expect(ago(before(3 * 86400), NOW)).toBe('3d ago');
  });
  it('countdown: expired at or past the time, else how long until', () => {
    expect(countdown(before(0), NOW)).toBe('expired');
    expect(countdown(new Date(NOW + 65_000).toISOString(), NOW)).toBe('in 1m 5s');
  });
});
