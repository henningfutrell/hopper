// The usage graph's model (issues #385, #502): one line per account and usage window — the account is one
// series however many machines read it, named by the account and the window; the lines of one account share
// a colour and differ by dash (session solid, week dashed, informational dotted and hidden until chosen); a
// gap breaks a line at every graph step; hovering reads every shown line at that time; zooming narrows or
// widens the stretch shown, and the graph step follows it from a day at the week down to an hour.
import { describe, expect, it } from 'vitest';
import type { UsageSeries } from '../../src/domain/types.ts';
import { graphStepFor, STEP_MS } from '../../src/domain/usage-history.ts';
import { graphLines, hiddenLines, lineSegments, MIN_ZOOM_MS, selected, totalsAsSeries, valuesAt, zoomed } from '../../ui/src/model/usage-history.ts';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const pts = (...hours: [number, number][]) => hours.map(([h, f]) => ({ at: iso(T0 + h * H), usedFrac: f }));
const series = (account: string, window: string | undefined, o: Partial<UsageSeries> = {}): UsageSeries =>
  ({ account, ...(window ? { window } : {}), informational: false, unit: '%', points: pts([0, 0.1]), gaps: [], resets: [], ...o });

describe('usage graph lines', () => {
  it('four accounts, two windows each: eight lines shown, each account one colour, session solid and week dashed', () => {
    const all = ['a', 'b', 'c', 'd'].flatMap((s) => [
      series(`${s}@example.com`, 'session'), series(`${s}@example.com`, 'week'),
      series(`${s}@example.com`, 'week (Fable)', { informational: true }),
    ]);
    const lines = graphLines(all);
    expect(lines.filter((l) => l.shownByDefault)).toHaveLength(8);
    expect(lines.find((l) => l.key === 'a@example.com|session')).toMatchObject({ label: 'a@example.com · session', dash: 'solid', shownByDefault: true });
    expect(lines.find((l) => l.key === 'a@example.com|week')).toMatchObject({ label: 'a@example.com · week', dash: 'dashed' });
    expect(lines.find((l) => l.key === 'a@example.com|week (Fable)')).toMatchObject({ dash: 'dotted', shownByDefault: false });
    const colourOf = (s: string) => new Set(lines.filter((l) => l.key.startsWith(`${s}@`)).map((l) => l.color));
    for (const s of ['a', 'b', 'c', 'd']) expect(colourOf(s).size).toBe(1);
    expect(new Set(['a', 'b', 'c', 'd'].map((s) => [...colourOf(s)][0])).size).toBe(4);
  });

  it('the legend names the account and the window, never a machine', () => {
    expect(graphLines([series('me@example.com', 'session')])[0]!.label).toBe('me@example.com · session');
    expect(graphLines([series('plan', undefined)])[0]!.label).toBe('plan');
  });
});

describe('a line\'s segments', () => {
  it('adjacent steps join; a gap between two points breaks the line there', () => {
    const s = series('a', 'session', { points: pts([0, 0.1], [1, 0.2], [2, 0.3], [6, 0.4], [7, 0.5]), gaps: [{ from: iso(T0 + 2.5 * H), to: iso(T0 + 6 * H) }] });
    expect(lineSegments(s, H).map((seg) => seg.map((p) => p.v))).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5]]);
  });

  it('steps with no sample between two points but no gap (a source that reads less often than the step) still join', () => {
    const s = series('a', 'session', { points: pts([0, 0.1], [2, 0.2], [4, 0.3]) });
    expect(lineSegments(s, H)).toHaveLength(1);
  });

  it('a gap of two days breaks the line at an hour, six hours and a day; a gap inside one step does not', () => {
    const gap = { from: iso(T0 + 26 * H), to: iso(T0 + 74 * H) };
    const at = (stepMs: number, hours: number[]) => series('a', 'session', { points: hours.map((h) => ({ at: iso(T0 + h * H), usedFrac: 0.1 })), gaps: [gap] });
    expect(lineSegments(at(H, [24, 25, 26, 74, 75]), H)).toHaveLength(2);
    expect(lineSegments(at(6 * H, [18, 24, 78, 84]), 6 * H)).toHaveLength(2);
    expect(lineSegments(at(D, [0, 24, 72, 96]), D)).toHaveLength(2);
    expect(lineSegments(at(7 * D, [0]), 7 * D)).toHaveLength(1);
  });
});

describe('hovering', () => {
  it('reads each shown line at the step under the pointer; a line with no point there has none', () => {
    const lines = graphLines([series('a', 'session', { points: pts([0, 0.1], [1, 0.25]) }), series('a', 'week', { points: pts([0, 0.5]) })]);
    expect(valuesAt(lines, T0 + 1.5 * H, H, new Set())).toEqual([{ key: 'a|session', v: 0.25 }]);
    expect(valuesAt(lines, T0 + 0.5 * H, H, new Set(['a|week']))).toEqual([{ key: 'a|session', v: 0.1 }]);
  });
});

describe('the legend', () => {
  it('hides what it toggled off and the informational lines it did not toggle on', () => {
    const lines = graphLines([series('a', 'session'), series('a', 'week'), series('a', 'week (Fable)', { informational: true })]);
    expect([...hiddenLines(lines, new Map())]).toEqual(['a|week (Fable)']);
    expect([...hiddenLines(lines, new Map([['a|session', true], ['a|week (Fable)', false]]))]).toEqual(['a|session']);
  });
});

describe('the graph step for a graph range', () => {
  it('an hour up to two days, six hours up to four, a day up to sixty, a week past that', () => {
    const step = (ms: number) => STEP_MS[graphStepFor(ms)];
    expect([3 * H, D, 2 * D].map(step)).toEqual([H, H, H]);
    expect([2 * D + 1, 3 * D, 4 * D].map(step)).toEqual([6 * H, 6 * H, 6 * H]);
    expect([4 * D + 1, 7 * D, 30 * D, 60 * D].map(step)).toEqual([D, D, D, D]);
    expect([60 * D + 1, 90 * D].map(step)).toEqual([7 * D, 7 * D]);
  });
});

describe('zooming', () => {
  const now = T0 + 7 * D;
  const week = { from: T0, to: now };
  const limits = { now, maxMs: 90 * D };

  it('the default week is per day; zooming in about the middle reaches hourly steps, and zooming out the same steps comes back to the week per day', () => {
    expect(STEP_MS[graphStepFor(week.to - week.from)]).toBe(D);
    const middle = (s: { from: number; to: number }) => (s.from + s.to) / 2;
    let s = week;
    const steps: number[] = [];
    for (let i = 0; i < 3; i++) { s = zoomed(s, 0.5, middle(s), limits); steps.push(STEP_MS[graphStepFor(s.to - s.from)]); }
    expect(steps).toEqual([6 * H, H, H]);
    expect(s.to - s.from).toBe(7 * D / 8);
    for (let i = 0; i < 3; i++) s = zoomed(s, 2, middle(s), limits);
    expect(s).toEqual(week);
    expect(STEP_MS[graphStepFor(s.to - s.from)]).toBe(D);
  });

  it('the time under the pointer stays where it is', () => {
    const at = T0 + D;
    const s = zoomed(week, 0.5, at, limits);
    expect((at - s.from) / (s.to - s.from)).toBeCloseTo((at - week.from) / (week.to - week.from));
  });

  it('never narrower than the least stretch, never past now, never wider than the history', () => {
    let s = week;
    for (let i = 0; i < 20; i++) s = zoomed(s, 0.5, now - H, limits);
    expect(s.to - s.from).toBe(MIN_ZOOM_MS);
    expect(s.to).toBeLessThanOrEqual(now);
    expect(zoomed(week, 2, now, limits)).toEqual({ from: now - 14 * D, to: now });
    expect(zoomed(week, 100, now, limits)).toEqual({ from: now - 90 * D, to: now });
  });

  it('a stretch dragged across, in either direction, is the stretch shown; a short one widens to the least stretch about its middle', () => {
    expect(selected(T0 + 2 * D, T0 + D, limits)).toEqual({ from: T0 + D, to: T0 + 2 * D });
    const short = selected(T0 + D, T0 + D + 60_000, limits);
    expect(short.to - short.from).toBe(MIN_ZOOM_MS);
    expect((short.from + short.to) / 2).toBe(T0 + D + 30_000);
  });
});

describe('the instance usage totals as lines', () => {
  it('one colour for all users, a dash per window; nothing named', () => {
    const lines = graphLines(totalsAsSeries([
      { unit: '%', window: 'session', informational: false, points: [{ at: iso(T0), usedFrac: 0.45, series: 2 }] },
      { unit: '%', window: 'week', informational: false, points: [] },
    ]));
    expect(lines.map((l) => [l.label, l.dash])).toEqual([['all users · session', 'solid'], ['all users · week', 'dashed']]);
    expect(new Set(lines.map((l) => l.color)).size).toBe(1);
  });
});
