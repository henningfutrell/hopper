// Lane tuning in the UI (ui/src/model/lane-tuning.ts, issue #688), pure: the line that compares the recommended lanes
// with the configured lanes, the confidence, and the change a save sends — only what differs, refused when a bound is
// not a whole number of lanes from 0 to 64 or the least is more than the most.
import { describe, expect, it } from 'vitest';
import type { LaneRecommendation } from '../../src/domain/types.ts';
import { confidenceText, laneTuningPatch, recommendationLine } from '../../ui/src/model/lane-tuning.ts';

const rec = (over: Partial<LaneRecommendation> = {}): LaneRecommendation => ({
  machineId: 'm', online: true, configured: 2, lanes: 4, headroom: 4, reason: 'r', confidence: 0.33, usedFrac: 0, usage: 'free',
  tuning: { autoTune: true, minLanes: 1, maxLanes: 8 }, ...over,
});

describe('lane tuning model', () => {
  it('compares the recommended lanes with the configured lanes', () => {
    expect(recommendationLine(rec())).toBe('Recommends 4 lanes; configured 2: 2 more');
    expect(recommendationLine(rec({ lanes: 1 }))).toBe('Recommends 1 lane; configured 2: 1 fewer');
    expect(recommendationLine(rec({ lanes: 2 }))).toBe('Recommends the configured 2 lanes');
    expect(recommendationLine(rec({ lanes: 2, tuning: { autoTune: false, minLanes: 1, maxLanes: 8 } }))).toBe('Auto-tune is off: 2 lanes configured');
  });

  it('the confidence as a percentage; none without history', () => {
    expect(confidenceText(rec())).toBe('confidence 33%');
    expect(confidenceText(rec({ confidence: 0 }))).toBe('no history yet');
  });

  it('a save sends only what differs; a bound that is not a whole number of lanes, or bounds that cross, are refused', () => {
    const t = { autoTune: true, minLanes: 1, maxLanes: 8 };
    expect(laneTuningPatch(t, { autoTune: true, minLanes: '1', maxLanes: '8' })).toEqual({ ok: true, patch: undefined });
    expect(laneTuningPatch(t, { autoTune: false, minLanes: '1', maxLanes: ' 3 ' })).toEqual({ ok: true, patch: { autoTune: false, maxLanes: 3 } });
    expect(laneTuningPatch(t, { autoTune: true, minLanes: '1.5', maxLanes: '8' })).toEqual({ ok: false, error: 'Least lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { autoTune: true, minLanes: '1', maxLanes: '65' })).toEqual({ ok: false, error: 'Most lanes: a whole number from 0 to 64' });
    expect(laneTuningPatch(t, { autoTune: true, minLanes: '5', maxLanes: '4' })).toEqual({ ok: false, error: 'The least lanes must not be more than the most lanes' });
  });
});
