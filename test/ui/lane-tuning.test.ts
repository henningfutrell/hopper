// Lane tuning in the UI (ui/src/model/lane-tuning.ts, issue #688), pure: the line that compares the recommended lanes
// with the configured lanes, the confidence, and the change a save sends — only what differs, refused when a bound is
// not a whole number of lanes from 0 to 64 or the least is more than the most —, in active mode the lanes in use, and a
// line per change in the history.
import { describe, expect, it } from 'vitest';
import type { LaneRecommendation } from '../../src/domain/types.ts';
import { changeLine, confidenceText, laneTuningPatch, recommendationLine } from '../../ui/src/model/lane-tuning.ts';

const T = { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'shadow' } as const;
const rec = (over: Partial<LaneRecommendation> = {}): LaneRecommendation => ({
  machineId: 'm', online: true, configured: 2, inUse: 2, lanes: 4, headroom: 4, reason: 'r', confidence: 0.33, usedFrac: 0, usage: 'free',
  tuning: T, ...over,
});

describe('lane tuning model', () => {
  it('compares the recommended lanes with the configured lanes', () => {
    expect(recommendationLine(rec())).toBe('Recommends 4 lanes; configured 2: 2 more');
    expect(recommendationLine(rec({ lanes: 1 }))).toBe('Recommends 1 lane; configured 2: 1 fewer');
    expect(recommendationLine(rec({ lanes: 2 }))).toBe('Recommends the configured 2 lanes');
    expect(recommendationLine(rec({ lanes: 2, tuning: { ...T, autoTune: false } }))).toBe('Auto-tune is off: 2 lanes configured');
  });

  it('in active mode, the lanes in use next to the recommendation and the configured lanes', () => {
    const active = { ...T, mode: 'active' } as const;
    expect(recommendationLine(rec({ tuning: active, inUse: 4 }))).toBe('4 lanes in use, as recommended; configured 2');
    expect(recommendationLine(rec({ tuning: active, inUse: 2, lanes: 3 }))).toBe('Recommends 3 lanes; 2 in use, configured 2');
  });

  it('a change in the history, in one line', () => {
    expect(changeLine({ at: 'x', machineId: 'm', kind: 'applied', from: 2, to: 4, reason: 'room for 2 more' })).toBe('2 → 4 lanes: room for 2 more');
    expect(changeLine({ at: 'x', machineId: 'm', kind: 'undone', from: 4, to: 2, by: 'someone' })).toBe('4 → 2 lanes: undone by someone');
  });

  it('the confidence as a percentage; none without history', () => {
    expect(confidenceText(rec())).toBe('confidence 33%');
    expect(confidenceText(rec({ confidence: 0 }))).toBe('no history yet');
  });

  it('a save sends only what differs; a bound that is not a whole number of lanes, or bounds that cross, are refused', () => {
    const t = T;
    const d = { autoTune: true, minLanes: '1', maxLanes: '8', mode: 'shadow' } as const;
    expect(laneTuningPatch(t, d)).toEqual({ ok: true, patch: undefined });
    expect(laneTuningPatch(t, { ...d, autoTune: false, maxLanes: ' 3 ' })).toEqual({ ok: true, patch: { autoTune: false, maxLanes: 3 } });
    expect(laneTuningPatch(t, { ...d, mode: 'active' })).toEqual({ ok: true, patch: { mode: 'active' } });
    expect(laneTuningPatch(t, { ...d, minLanes: '1.5' })).toEqual({ ok: false, error: 'Least lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { ...d, maxLanes: '65' })).toEqual({ ok: false, error: 'Most lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { ...d, minLanes: '5', maxLanes: '4' })).toEqual({ ok: false, error: 'The least lanes must not be more than the most lanes' });
  });
});
