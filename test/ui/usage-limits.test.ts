// The usage limits editor's model (issue #522, ui/src/model/usage-limits.ts): a soft limit at or above the hard one,
// or out of 0-100%, is refused before the daemon sees it; a dragged limit moves in whole percents and stops one
// short of the other; the band and the lane cap at a draft follow the decider's rule; the throttle line is the
// highest throttling reading at each graph step, informational lines left out. Issue #2091: the soft lanes are a whole
// number from 0; from soft to hard the lane cap is the soft lanes (1 when none), at most the machine's lanes.
import { describe, expect, it } from 'vitest';
import type { UsageSeries } from '../../src/domain/types.ts';
import { bandAt, capAt, dragLimit, limitsProblem, throttleLine, windowLines } from '../../ui/src/model/usage-limits.ts';

const L = { soft: 0.7, hard: 0.95 };

describe('usage limits model', () => {
  it('refuses soft at or above hard, and anything out of 0-100%, saying why', () => {
    expect(limitsProblem(L)).toBeUndefined();
    expect(limitsProblem({ soft: 0.8, hard: 0.8 })).toBe('The soft limit must be below the hard limit.');
    expect(limitsProblem({ soft: 0.9, hard: 0.5 })).toBe('The soft limit must be below the hard limit.');
    expect(limitsProblem({ soft: -0.01, hard: 0.5 })).toBe('Each limit is from 0% to 100%.');
    expect(limitsProblem({ soft: 0.5, hard: 1.01 })).toBe('Each limit is from 0% to 100%.');
    expect(limitsProblem({ soft: Number.NaN, hard: 0.5 })).toBe('Each limit is from 0% to 100%.');
    expect(limitsProblem({ ...L, softLanes: 0 })).toBeUndefined();
    for (const softLanes of [-1, 1.5, Number.NaN]) expect(limitsProblem({ ...L, softLanes })).toBe('The soft lanes are a whole number from 0.');
  });

  it('a dragged limit moves in whole percents, within 0-100%, and stops one percent short of the other', () => {
    expect(dragLimit(L, 'soft', 0.523)).toEqual({ soft: 0.52, hard: 0.95 });
    expect(dragLimit(L, 'soft', 0.99)).toEqual({ soft: 0.94, hard: 0.95 });
    expect(dragLimit(L, 'hard', 0.2)).toEqual({ soft: 0.7, hard: 0.71 });
    expect(dragLimit(L, 'hard', 1.4)).toEqual({ soft: 0.7, hard: 1 });
    expect(dragLimit(L, 'soft', -3)).toEqual({ soft: 0, hard: 0.95 });
  });

  it('the band and the lane cap follow the decider: all lanes below soft, the soft lanes between, none at hard', () => {
    expect(bandAt(0.5, L)).toBe('free');
    expect(bandAt(0.7, L)).toBe('soft');
    expect(bandAt(0.95, L)).toBe('hard');
    expect(capAt(4, 0.5, L)).toBe(4);
    for (const f of [0.7, 0.825, 0.949]) expect(capAt(4, f, L)).toBe(1);
    expect(capAt(4, 0.825, { ...L, softLanes: 3 })).toBe(3);
    expect(capAt(4, 0.825, { ...L, softLanes: 9 })).toBe(4);
    expect(capAt(4, 0.825, { ...L, softLanes: 0 })).toBe(0);
    expect(capAt(4, 0.95, { ...L, softLanes: 3 })).toBe(0);
  });

  it('a dragged limit keeps the soft lanes', () => {
    expect(dragLimit({ ...L, softLanes: 2 }, 'soft', 0.5)).toEqual({ soft: 0.5, hard: 0.95, softLanes: 2 });
  });

  it('the throttle line: the highest throttling line at each step, informational lines left out', () => {
    const s = (points: [string, number][], informational = false): UsageSeries =>
      ({ account: 'a', informational, unit: '%', gaps: [], resets: [], points: points.map(([at, usedFrac]) => ({ at, usedFrac })) });
    const line = throttleLine([
      s([['2026-10-08T01:00:00.000Z', 0.2], ['2026-10-08T02:00:00.000Z', 0.4]]),
      s([['2026-10-08T02:00:00.000Z', 0.6], ['2026-10-08T03:00:00.000Z', 0.1]]),
      s([['2026-10-08T02:00:00.000Z', 0.99]], true),
    ]);
    expect(line).toEqual([
      { t: Date.parse('2026-10-08T01:00:00.000Z'), v: 0.2 },
      { t: Date.parse('2026-10-08T02:00:00.000Z'), v: 0.6 },
      { t: Date.parse('2026-10-08T03:00:00.000Z'), v: 0.1 },
    ]);
  });

  it('a line per throttling window (issue #2169): labelled by its window, informational ones left out', () => {
    const s = (window: string | undefined, account: string, informational = false): UsageSeries =>
      ({ account, ...(window ? { window } : {}), informational, unit: '%', gaps: [], resets: [], points: [{ at: '2026-10-08T01:00:00.000Z', usedFrac: 0.5 }] });
    expect(windowLines([s('session', 'a'), s('week', 'a'), s('week (Fable)', 'a', true)]).map((l) => l.label)).toEqual(['session', 'weekly']);
    expect(windowLines([s('week', 'a')])[0]!.points).toEqual([{ t: Date.parse('2026-10-08T01:00:00.000Z'), v: 0.5 }]);
    // Two accounts with the same window: the account tells them apart; a source with one budget: its name.
    expect(windowLines([s('week', 'a'), s('week', 'b'), s(undefined, 'budget')]).map((l) => l.label)).toEqual(['weekly · a', 'weekly · b', 'budget']);
  });

  it('a burning week window reaches the hard band only when spent', () => {
    expect(bandAt(0.97, { ...L, hard: 0.95 }, true)).toBe('soft');
    expect(bandAt(1, L, true)).toBe('hard');
    expect(capAt(4, 0.97, L, true)).toBe(1);
  });
});
