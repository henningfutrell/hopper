// Lane tuning in the UI (ui/src/model/lane-tuning.ts, issue #688), pure: the line that compares the recommended lanes
// with the configured lanes, the confidence, and the change a save sends — only what differs, refused when a bound is
// not a whole number of lanes from 0 to 64 or the least is more than the most —, a line per change in the history, and
// a dismissed recommendation.
import { describe, expect, it } from 'vitest';
import type { LaneRecommendation } from '../../src/domain/types.ts';
import { changeLine, confidenceText, dismissedLine, laneTuningPatch, recommendationLine } from '../../ui/src/model/lane-tuning.ts';

const T = { autoTune: true, minLanes: 1, maxLanes: 8 } as const;
const rec = (over: Partial<LaneRecommendation> = {}): LaneRecommendation => ({
  machineId: 'm', online: true, configured: 2, lanes: 4, headroom: 4, reason: 'r', confidence: 0.33, usedFrac: 0, usage: 'free',
  tuning: T, ...over,
});

describe('lane tuning model', () => {
  it('compares the recommended lanes with the configured lanes', () => {
    expect(recommendationLine(rec())).toBe('Recommends 4 lanes; configured 2: 2 more');
    expect(recommendationLine(rec({ lanes: 1 }))).toBe('Recommends 1 lane; configured 2: 1 fewer');
    expect(recommendationLine(rec({ lanes: 2 }))).toBe('Recommends the configured 2 lanes');
    expect(recommendationLine(rec({ lanes: 2, tuning: { ...T, autoTune: false } }))).toBe('Auto-tune is off: 2 lanes configured');
  });

  it('a change in the history, in one line', () => {
    expect(changeLine({ at: 'x', machineId: 'm', kind: 'applied', from: 2, to: 4, reason: 'room for 2 more', by: 'someone' })).toBe('2 → 4 lanes: applied by someone: room for 2 more');
    // Applied by the hopper itself, before an admin applied each one.
    expect(changeLine({ at: 'x', machineId: 'm', kind: 'applied', from: 2, to: 4, reason: 'room for 2 more' })).toBe('2 → 4 lanes: room for 2 more');
    expect(changeLine({ at: 'x', machineId: 'm', kind: 'undone', from: 4, to: 2, by: 'someone' })).toBe('4 → 2 lanes: undone by someone');
  });

  it('a dismissed recommendation says who dismissed it', () => {
    expect(dismissedLine(rec({ dismissed: { at: '2026-10-10T12:00:00.000Z', by: 'someone' } }))).toBe('Dismissed by someone; shown again when the recommendation moves');
    expect(dismissedLine(rec())).toBeUndefined();
  });

  it('the confidence as a percentage; none without history', () => {
    expect(confidenceText(rec())).toBe('confidence 33%');
    expect(confidenceText(rec({ confidence: 0 }))).toBe('no history yet');
  });

  it('a save sends only what differs; a bound that is not a whole number of lanes, or bounds that cross, are refused', () => {
    const t = T;
    const d = { autoTune: true, minLanes: '1', maxLanes: '8' } as const;
    expect(laneTuningPatch(t, d)).toEqual({ ok: true, patch: undefined });
    expect(laneTuningPatch(t, { ...d, autoTune: false, maxLanes: ' 3 ' })).toEqual({ ok: true, patch: { autoTune: false, maxLanes: 3 } });
    expect(laneTuningPatch(t, { ...d, minLanes: '1.5' })).toEqual({ ok: false, error: 'Least lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { ...d, maxLanes: '65' })).toEqual({ ok: false, error: 'Most lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { ...d, minLanes: '5', maxLanes: '4' })).toEqual({ ok: false, error: 'The least lanes must not be more than the most lanes' });
  });
});
