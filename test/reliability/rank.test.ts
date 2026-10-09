// Issue #535: the most reliable lanes become the priority lanes, with hysteresis so one failure does not move them,
// and an admin's choice wins.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY_LANE_SETTINGS, type LaneReliability, type PriorityLaneSettings } from '../../src/domain/types.ts';
import { rank, SWITCH_MARGIN, type LaneSlot } from '../../src/reliability/rank.ts';

const settings = (over: Partial<PriorityLaneSettings> = {}): PriorityLaneSettings => ({ ...DEFAULT_PRIORITY_LANE_SETTINGS, ...over });
const stat = (laneId: string, runs: number, laneFaults: number, over: Partial<LaneReliability> = {}): LaneReliability => ({
  laneId, machineId: laneId.split('/')[0]!, runs, finished: runs - laneFaults, failed: laneFaults, laneFaults, recentFaults: 0,
  score: (runs - laneFaults) / runs, ...over,
});
const slot = (laneId: string, online = true): LaneSlot => ({ laneId, machineId: laneId.split('/')[0]!, online });
const slots = ['a/lane-1', 'a/lane-2', 'b/lane-1', 'b/lane-2'].map((id) => slot(id));

describe('rank', () => {
  it('chooses the most reliable lanes, as many as the count', () => {
    const r = rank({ stats: [stat('a/lane-1', 10, 3), stat('a/lane-2', 10, 0), stat('b/lane-1', 10, 1), stat('b/lane-2', 10, 2)], slots, previous: [], settings: settings({ count: 2 }) });
    expect(r.chosen).toEqual(['a/lane-2', 'b/lane-1']);
    expect(r.by).toBe('reliability');
    expect(r.lanes.find((l) => l.laneId === 'a/lane-2')).toMatchObject({ rank: 1, priority: true, reason: 'priority lane: rank 1, 100% of 10 runs without a lane fault' });
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')).toMatchObject({ rank: 4, priority: false, reason: 'rank 4: the 2 priority lanes are more reliable' });
  });

  it('ranks no lane short of the minimum runs, nor on a machine offline, and says why', () => {
    const r = rank({
      stats: [stat('a/lane-1', 4, 0), stat('b/lane-1', 10, 0)],
      slots: [slot('a/lane-1'), slot('b/lane-1', false)], previous: [], settings: settings(),
    });
    expect(r.chosen).toEqual([]);
    expect(r.by).toBe('none');
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')).toMatchObject({ priority: false, reason: 'not ranked: 4 of the 5 runs needed in 14 days' });
    expect(r.lanes.find((l) => l.laneId === 'b/lane-1')).toMatchObject({ priority: false, reason: 'not ranked: machine b is offline' });
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')!.rank).toBeUndefined();
  });

  it('lists every lane slot, those with no history too', () => {
    const r = rank({ stats: [], slots, previous: [], settings: settings() });
    expect(r.lanes.map((l) => l.laneId)).toEqual(['a/lane-1', 'a/lane-2', 'b/lane-1', 'b/lane-2']);
    expect(r.lanes[0]).toMatchObject({ runs: 0, score: 0, reason: 'not ranked: 0 of the 5 runs needed in 14 days' });
  });

  it('does not flap: one lane fault keeps a priority lane within the margin of a better one', () => {
    const r = rank({ stats: [stat('a/lane-1', 20, 1), stat('b/lane-1', 20, 0)], slots, previous: ['a/lane-1'], settings: settings() });
    expect(r.chosen).toEqual(['a/lane-1']);
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')!.reason).toBe(`priority lane: rank 2, kept: within ${SWITCH_MARGIN * 100} points of rank 1, so the choice does not flap`);
  });

  it('moves once a lane is better by more than the margin', () => {
    const r = rank({ stats: [stat('a/lane-1', 20, 5), stat('b/lane-1', 20, 0)], slots, previous: ['a/lane-1'], settings: settings() });
    expect(r.chosen).toEqual(['b/lane-1']);
  });

  it('drops a priority lane whose machine went offline', () => {
    const r = rank({ stats: [stat('a/lane-1', 20, 0), stat('b/lane-1', 20, 1)], slots: [slot('a/lane-1', false), slot('b/lane-1')], previous: ['a/lane-1'], settings: settings() });
    expect(r.chosen).toEqual(['b/lane-1']);
  });

  it('count 0: no priority lanes', () => {
    const r = rank({ stats: [stat('a/lane-1', 20, 0)], slots, previous: ['a/lane-1'], settings: settings({ count: 0 }) });
    expect(r.chosen).toEqual([]);
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')!.reason).toBe('rank 1: priority lanes are off (count 0)');
  });

  it('an admin\'s choice wins over the ranking', () => {
    const r = rank({ stats: [stat('a/lane-1', 20, 0), stat('b/lane-2', 20, 9)], slots, previous: [], settings: settings({ manual: ['b/lane-2'] }) });
    expect(r).toMatchObject({ chosen: ['b/lane-2'], by: 'manual' });
    expect(r.lanes.find((l) => l.laneId === 'b/lane-2')).toMatchObject({ priority: true, reason: 'priority lane: chosen by an admin' });
    expect(r.lanes.find((l) => l.laneId === 'a/lane-1')).toMatchObject({ rank: 1, priority: false, reason: 'rank 1: an admin chose the priority lanes' });
  });
});
