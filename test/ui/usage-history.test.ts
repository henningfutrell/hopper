// The usage graph's model (issue #385): one line per usage source and usage window, named by account and
// window; the lines of one account share a colour and differ by dash (session solid, week dashed,
// informational dotted and hidden until chosen); a gap breaks a line; hovering reads every shown line at
// that time.
import { describe, expect, it } from 'vitest';
import type { UsageSeries } from '../../src/domain/types.ts';
import { graphLines, lineSegments, valuesAt } from '../../ui/src/model/usage-history.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const pts = (...hours: [number, number][]) => hours.map(([h, f]) => ({ at: iso(T0 + h * H), usedFrac: f }));
const series = (source: string, window: string | undefined, o: Partial<UsageSeries> = {}): UsageSeries =>
  ({ source, ...(window ? { window } : {}), informational: false, unit: '%', points: pts([0, 0.1]), gaps: [], resets: [], ...o });

describe('usage graph lines', () => {
  it('four accounts, two windows each: eight lines shown, each account one colour, session solid and week dashed', () => {
    const all = ['a', 'b', 'c', 'd'].flatMap((s) => [
      series(s, 'session', { account: `${s}@example.com` }), series(s, 'week', { account: `${s}@example.com` }),
      series(s, 'week (Fable)', { account: `${s}@example.com`, informational: true }),
    ]);
    const lines = graphLines(all);
    expect(lines.filter((l) => l.shownByDefault)).toHaveLength(8);
    expect(lines.find((l) => l.key === 'a||session')).toMatchObject({ label: 'a@example.com · session', dash: 'solid', shownByDefault: true });
    expect(lines.find((l) => l.key === 'a||week')).toMatchObject({ label: 'a@example.com · week', dash: 'dashed' });
    expect(lines.find((l) => l.key === 'a||week (Fable)')).toMatchObject({ dash: 'dotted', shownByDefault: false });
    const colourOf = (s: string) => new Set(lines.filter((l) => l.key.startsWith(`${s}|`)).map((l) => l.color));
    for (const s of ['a', 'b', 'c', 'd']) expect(colourOf(s).size).toBe(1);
    expect(new Set(['a', 'b', 'c', 'd'].map((s) => [...colourOf(s)][0])).size).toBe(4);
  });

  it('no account known: the line is named by its source, and its machine when it has one', () => {
    const [line] = graphLines([series('claude', 'session', { machineId: 'box' })]);
    expect(line!.label).toBe('claude (box) · session');
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
});

describe('hovering', () => {
  it('reads each shown line at the step under the pointer; a line with no point there has none', () => {
    const lines = graphLines([series('a', 'session', { points: pts([0, 0.1], [1, 0.25]) }), series('a', 'week', { points: pts([0, 0.5]) })]);
    expect(valuesAt(lines, T0 + 1.5 * H, H, new Set())).toEqual([{ key: 'a||session', v: 0.25 }]);
    expect(valuesAt(lines, T0 + 0.5 * H, H, new Set(['a||week']))).toEqual([{ key: 'a||session', v: 0.1 }]);
  });
});
