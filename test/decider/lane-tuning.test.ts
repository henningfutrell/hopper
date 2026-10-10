// Lane tuning (issue #688): lane headroom from lane load — the most lanes in use the history shows without resource
// pressure, plus what each lane's measured cost leaves room for — and the lane recommendation within the bounds, with
// no lanes added near or past the soft limit.
import { describe, expect, it } from 'vitest';
import { laneHeadroom, recommendLanes } from '../../src/decider/lane-tuning.ts';
import { DEFAULT_LANE_TUNING, type LaneLoad } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;

/** Lane load of `m` at `lanesBusy` lanes: 60 samples, no pressure, 16 GiB of memory. */
const load = (lanesBusy: number, over: Partial<LaneLoad> = {}): LaneLoad => ({
  machineId: 'm', lanesBusy, samples: 60, pressured: { cpu: 0, memory: 0, disk: 0 }, cpuAvg: 0.1, memUsedAvgBytes: 4 * GIB, memTotalBytes: 16 * GIB, ...over,
});

const machine = { id: 'm', label: 'box', online: true, maxLanes: 2 };
const free = { usedFrac: 0.2, soft: 0.7, hard: 0.95 };

describe('lane headroom', () => {
  it('none without ten minutes at a lane count of one or more', () => {
    expect(laneHeadroom([])).toBeUndefined();
    expect(laneHeadroom([load(0), load(1, { samples: 9 })])).toBeUndefined();
  });

  it('one less than the first lane count with resource pressure, naming the resource', () => {
    const h = laneHeadroom([load(0), load(1), load(2), load(3, { samples: 40, pressured: { cpu: 0, memory: 5, disk: 0 } }), load(4)]);
    expect(h).toMatchObject({ lanes: 2, samples: 60 });
    expect(h!.why).toBe('memory pressure at 3 lanes in use (5 of 40 samples): 2 lanes run without it');
  });

  it('pressure in a few samples is not pressure', () => {
    expect(laneHeadroom([load(0), load(2, { pressured: { cpu: 3, memory: 0, disk: 0 } })])?.lanes).toBeGreaterThanOrEqual(2);
  });

  it('pressure at one lane leaves no lane', () => {
    expect(laneHeadroom([load(1, { pressured: { cpu: 0, memory: 0, disk: 30 } })])).toMatchObject({ lanes: 0 });
  });

  it('past the most lanes seen, as many as each lane\'s measured cost leaves room for, at most 2 more', () => {
    // A lane costs 2 GiB and 10% CPU: at 2 lanes 8 GiB used and 30% CPU; room to 85% memory (13.6 GiB) is 2 lanes, to 90% CPU 6.
    const h = laneHeadroom([load(0), load(1, { memUsedAvgBytes: 6 * GIB, cpuAvg: 0.2 }), load(2, { memUsedAvgBytes: 8 * GIB, cpuAvg: 0.3 })]);
    expect(h).toMatchObject({ lanes: 4, samples: 60 });
    expect(h!.why).toBe('no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more');
    // Memory leaves room for one only.
    expect(laneHeadroom([load(0), load(2, { memUsedAvgBytes: 10 * GIB })])?.lanes).toBe(3);
    // Already past the targets: none more.
    expect(laneHeadroom([load(0), load(2, { memUsedAvgBytes: 14 * GIB })])?.lanes).toBe(2);
  });

  it('with one lane count only, no lane\'s cost is known: no more', () => {
    const h = laneHeadroom([load(2)]);
    expect(h).toMatchObject({ lanes: 2 });
    expect(h!.why).toBe('no resource pressure at 2 lanes in use, the most seen; no lower lane count to measure a lane\'s cost');
  });
});

describe('lane recommendation', () => {
  it('the headroom, below the soft limit, with confidence from the samples it stands on', () => {
    const r = recommendLanes({ machine, loads: [load(0), load(1, { memUsedAvgBytes: 6 * GIB, cpuAvg: 0.2 }), load(2, { memUsedAvgBytes: 8 * GIB, cpuAvg: 0.3, samples: 30 })], ...free, tuning: DEFAULT_LANE_TUNING });
    expect(r).toMatchObject({ machineId: 'm', label: 'box', online: true, configured: 2, lanes: 4, headroom: 4, confidence: 0.5, usage: 'free', usedFrac: 0.2 });
  });

  it('no lanes added near the soft limit or past it; fewer when the headroom is lower', () => {
    const loads = [load(0), load(1, { memUsedAvgBytes: 6 * GIB }), load(2, { memUsedAvgBytes: 8 * GIB })];
    const near = recommendLanes({ machine, loads, ...free, usedFrac: 0.65, tuning: DEFAULT_LANE_TUNING });
    expect(near).toMatchObject({ lanes: 2, headroom: 4, usage: 'near' });
    expect(near.reason).toMatch(/usage 65% is near the soft limit 70%: no lanes added; high-priority work keeps its lanes/);
    expect(recommendLanes({ machine, loads, ...free, usedFrac: 0.8, tuning: DEFAULT_LANE_TUNING })).toMatchObject({ lanes: 2, usage: 'soft' });
    expect(recommendLanes({ machine, loads, ...free, usedFrac: 0.97, tuning: DEFAULT_LANE_TUNING })).toMatchObject({ lanes: 2, usage: 'hard' });
    const pressured = [load(0), load(1), load(2, { pressured: { cpu: 60, memory: 0, disk: 0 } })];
    expect(recommendLanes({ machine, loads: pressured, ...free, usedFrac: 0.8, tuning: DEFAULT_LANE_TUNING })).toMatchObject({ lanes: 1, headroom: 1 });
  });

  it('within the bounds, and says so', () => {
    const loads = [load(0), load(1, { memUsedAvgBytes: 5 * GIB }), load(2, { memUsedAvgBytes: 6 * GIB })];
    const r = recommendLanes({ machine, loads, ...free, tuning: { autoTune: true, minLanes: 1, maxLanes: 3 } });
    expect(r).toMatchObject({ lanes: 3, headroom: 4 });
    expect(r.reason).toMatch(/; kept within the bounds 1 to 3$/);
    const low = recommendLanes({ machine, loads: [load(1, { pressured: { cpu: 0, memory: 60, disk: 0 } })], ...free, tuning: { autoTune: true, minLanes: 1, maxLanes: 8 } });
    expect(low).toMatchObject({ lanes: 1, headroom: 0 });
  });

  it('the configured lanes, confidence 0: auto-tune off, offline, or not enough history', () => {
    const loads = [load(0), load(1, { memUsedAvgBytes: 6 * GIB }), load(2, { memUsedAvgBytes: 8 * GIB })];
    expect(recommendLanes({ machine, loads, ...free, tuning: { ...DEFAULT_LANE_TUNING, autoTune: false } }))
      .toMatchObject({ lanes: 2, confidence: 0, reason: 'auto-tune is off for this machine' });
    expect(recommendLanes({ machine: { ...machine, online: false }, loads, ...free, tuning: DEFAULT_LANE_TUNING }))
      .toMatchObject({ lanes: 2, confidence: 0, reason: 'offline: the configured lanes stay' });
    const none = recommendLanes({ machine, loads: [load(0)], ...free, tuning: DEFAULT_LANE_TUNING });
    expect(none).toMatchObject({ lanes: 2, confidence: 0 });
    expect(none).not.toHaveProperty('headroom');
    expect(none.reason).toBe('not enough history: no lane count of 1 or more ran for 10 minutes in the last 7 days');
  });
});
