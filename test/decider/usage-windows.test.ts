// Issue #2169: a machine is throttled by the highest of all its throttling usage windows — the session, the week, any
// other one not informational —, and the lane effect names the window that throttles it. A week window in its burn
// window still throttles at the soft limit; only its hard limit moves to 100%.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneEffect } from '../../src/decider/usage.ts';
import { inputs, job, machine, NOW, policy, reading } from './support.ts';

const H = 3_600_000;
const inHours = (h: number): string => new Date(Date.parse(NOW) + h * H).toISOString();
const six = machine({ maxLanes: 6, executors: ['claude'] });
// The issue's case: soft 70%, hard 99%, 1 soft lane.
const limits = { ...policy, softLimit: 0.7, hardLimit: 0.99, softLanes: 1 };
const claude = (window: string, used: number, over: Parameters<typeof reading>[2] = {}) =>
  reading(used, 100, { source: 'claude', window, executors: ['claude'], ...over });
const session = (used: number, resetInHours = 3) => claude('session', used, { resetsAt: inHours(resetInHours) });
const week = (used: number, resetInHours = 60) => claude('week', used, { resetsAt: inHours(resetInHours) });
const fable = (used: number) => claude('week (Fable)', used, { resetsAt: inHours(60), informational: true });

describe('the throttle reads every throttling window (issue #2169)', () => {
  it('session 7% and week 97%: the soft band, the soft lanes only, and the week is the cause', () => {
    const effect = laneEffect(six, [session(7), week(97), fable(2)], limits, NOW);
    expect(effect).toMatchObject({ usedFrac: 0.97, cap: 1, band: 'soft', throttle: { source: 'claude', window: 'week', usedFrac: 0.97 } });
    expect(effect.executors[0]).toMatchObject({ executor: 'claude', usedFrac: 0.97, cap: 1, band: 'soft', throttle: { window: 'week' } });
  });

  it('a week at or above hard starts nothing, however low the session', () => {
    for (const used of [99, 100]) expect(laneEffect(six, [session(1), week(used)], limits, NOW)).toMatchObject({ cap: 0, band: 'hard', throttle: { window: 'week' } });
    const d = decide(inputs({ machines: [six], usage: [session(1), week(99)], waiting: [job('a', { executor: 'claude' })], policy: limits }), 'd1');
    expect(d.start).toEqual([]);
  });

  it('an informational window never throttles, even when it is the highest', () => {
    expect(laneEffect(six, [session(10), week(20), fable(100)], limits, NOW)).toMatchObject({ usedFrac: 0.2, cap: 6, band: 'free', throttle: { window: 'week' } });
  });

  it('the session is the cause when it is the highest', () => {
    expect(laneEffect(six, [session(80), week(30)], limits, NOW)).toMatchObject({ cap: 1, band: 'soft', throttle: { window: 'session', usedFrac: 0.8 } });
  });

  it('a missing window: the windows there are throttle', () => {
    expect(laneEffect(six, [week(85)], limits, NOW)).toMatchObject({ cap: 1, band: 'soft', throttle: { window: 'week' } });
    expect(laneEffect(six, [session(85)], limits, NOW)).toMatchObject({ cap: 1, band: 'soft', throttle: { window: 'session' } });
    expect(laneEffect(six, [], limits, NOW)).toMatchObject({ usedFrac: 0, cap: 6, band: 'free' });
    expect(laneEffect(six, [], limits, NOW).throttle).toBeUndefined();
  });

  it('a stale reading of one window, read before it reset, no longer throttles; the other window still does', () => {
    const staleSession = claude('session', 99, { resetsAt: inHours(-1), at: inHours(-4) });
    expect(laneEffect(six, [staleSession, week(80)], limits, NOW)).toMatchObject({ usedFrac: 0.8, cap: 1, band: 'soft', throttle: { window: 'week' } });
  });

  it('a stale reading whose window has not reset still throttles', () => {
    const oldWeek = claude('week', 97, { resetsAt: inHours(60), at: inHours(-10) });
    expect(laneEffect(six, [session(5), oldWeek], limits, NOW)).toMatchObject({ cap: 1, band: 'soft', throttle: { window: 'week' } });
  });

  it('windows that reset at different times: each counts until its own reset', () => {
    const usage = [session(95, 2), week(75, 30)];
    expect(laneEffect(six, usage, limits, NOW)).toMatchObject({ band: 'soft', throttle: { window: 'session' } });
    // Past the session's reset, only the week counts.
    expect(laneEffect(six, usage, limits, inHours(3))).toMatchObject({ usedFrac: 0.75, band: 'soft', throttle: { window: 'week' } });
    // Past both resets, nothing throttles.
    expect(laneEffect(six, usage, limits, inHours(31))).toMatchObject({ usedFrac: 0, cap: 6, band: 'free' });
  });
});

describe('a burning week window still throttles at the soft limit (issue #2169)', () => {
  const burning = { ...limits, pacing: { burnWindowMs: 18 * H, resetAwarePlacement: false, criticalPriority: 0 } };

  it('week 97% 17 hours before its reset: the soft lanes, not every lane', () => {
    const effect = laneEffect(six, [session(7), week(97, 17), fable(2)], burning, NOW);
    expect(effect).toMatchObject({ usedFrac: 0.97, cap: 1, band: 'soft', throttle: { window: 'week', burning: true } });
  });

  it('its hard limit is 100%: at 99.5% it keeps the soft lanes, spent it starts nothing', () => {
    expect(laneEffect(six, [week(99.5, 17)], burning, NOW)).toMatchObject({ cap: 1, band: 'soft' });
    expect(laneEffect(six, [week(100, 17)], burning, NOW)).toMatchObject({ cap: 0, band: 'hard' });
  });

  it('below the soft limit it leaves every lane open', () => {
    expect(laneEffect(six, [week(60, 17)], burning, NOW)).toMatchObject({ cap: 6, band: 'free' });
  });
});
