// Lane tuning (issue #688): lane headroom from lane load — the most lanes in use the history shows without resource
// pressure, plus what each lane's measured cost leaves room for — and the lane recommendation within the bounds, with
// no lanes added near or past the soft limit. The hopper recommends; an admin applies a recommendation, dismisses it or
// undoes the last one applied: what each can do with a recommendation now.
import { describe, expect, it } from 'vitest';
import { laneActions, laneHeadroom, laneProgress, recommendLanes } from '../../src/decider/lane-tuning.ts';
import {
  DEFAULT_LANE_TUNING, type JobRun, type LaneChange, type LaneDismissal, type LaneLoad, type LaneProgress, type LaneRecommendation,
} from '../../src/domain/types.ts';

const GIB = 1024 ** 3;

/** Lane load of `m` at `lanesBusy` lanes: 60 samples, no pressure, 16 GiB of memory. */
const load = (lanesBusy: number, over: Partial<LaneLoad> = {}): LaneLoad => ({
  machineId: 'm', lanesBusy, samples: 60, pressured: { cpu: 0, memory: 0, disk: 0 }, cpuAvg: 0.1, memUsedAvgBytes: 4 * GIB, memTotalBytes: 16 * GIB, ...over,
});

const machine = { id: 'm', label: 'box', online: true, maxLanes: 2 };
const free = { usedFrac: 0.2, soft: 0.7, hard: 0.95, progress: [] };

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

/** Runs of `m` that ended at `lanesBusy` lanes in use: `runs` of them, `failed` failed. */
const prog = (lanesBusy: number, runs: number, failed: number): LaneProgress => ({ machineId: 'm', lanesBusy, runs, failed });

describe('slow progress', () => {
  const run = (lanesBusyAvg: number | undefined, end: JobRun['end'], machineId = 'm'): JobRun => ({
    jobId: 'j', machineId, startedAt: '2026-10-10T10:00:00.000Z', endedAt: '2026-10-10T10:30:00.000Z', end, samples: 30,
    ...(lanesBusyAvg === undefined ? {} : { lanesBusyAvg }), usage: {},
  });

  it('per machine and lane count, the runs that finished or failed and how many failed', () => {
    expect(laneProgress([
      run(1, 'finished'), run(1.4, 'failed'), run(2.6, 'failed'), run(3, 'finished'), run(2, 'finished', 'n'),
      // A person's act, not the machine's: not counted. No sample: no lane count.
      run(1, 'cancelled'), run(1, 'requeued'), run(1, 'parked'), run(undefined, 'failed'),
      // At most a fraction of a lane: one lane.
      run(0.4, 'failed'),
    ])).toEqual([prog(1, 3, 2), prog(3, 2, 1), { machineId: 'n', lanesBusy: 2, runs: 1, failed: 0 }]);
  });

  it('one less than the first lane count whose runs fail far more often than at fewer lanes', () => {
    const loads = [load(0), load(1), load(2), load(3), load(4)];
    const h = laneHeadroom(loads, [prog(1, 4, 0), prog(2, 2, 0), prog(3, 4, 3), prog(4, 6, 6)]);
    expect(h).toMatchObject({ lanes: 2, samples: 60 });
    expect(h!.why).toBe('slow progress at 3 lanes in use (3 of 4 runs failed; 0 of 6 at fewer lanes): 2 lanes run without it');
  });

  it('not slow progress: too few runs, a rise of 25% or less, or no runs at fewer lanes to compare', () => {
    const loads = [load(0), load(1), load(2)];
    expect(laneHeadroom(loads, [prog(1, 4, 0), prog(2, 3, 3)])?.lanes).toBeGreaterThanOrEqual(2);
    expect(laneHeadroom(loads, [prog(1, 4, 1), prog(2, 4, 2)])?.lanes).toBeGreaterThanOrEqual(2);
    expect(laneHeadroom(loads, [prog(1, 3, 0), prog(2, 4, 4)])?.lanes).toBeGreaterThanOrEqual(2);
    // Failures at one lane are the jobs', not the load's.
    expect(laneHeadroom(loads, [prog(1, 8, 8)])?.lanes).toBeGreaterThanOrEqual(2);
  });

  it('resource pressure at fewer lanes than slow progress still limits first', () => {
    const loads = [load(0), load(1), load(2, { pressured: { cpu: 30, memory: 0, disk: 0 } }), load(3)];
    expect(laneHeadroom(loads, [prog(1, 4, 0), prog(3, 4, 4)])).toMatchObject({ lanes: 1 });
    expect(laneHeadroom(loads, [prog(1, 4, 0), prog(2, 4, 4)])!.why).toMatch(/^slow progress at 2 lanes in use/);
  });

  it('the recommendation reads only its own machine\'s runs', () => {
    const loads = [load(0), load(1), load(2), load(3)];
    const other = [prog(1, 4, 0), prog(2, 4, 4)].map((p) => ({ ...p, machineId: 'n' }));
    expect(recommendLanes({ machine, loads, ...free, progress: other, tuning: DEFAULT_LANE_TUNING }).headroom).toBeGreaterThanOrEqual(3);
    expect(recommendLanes({ machine, loads, ...free, progress: [prog(1, 4, 0), prog(2, 4, 4)], tuning: DEFAULT_LANE_TUNING }))
      .toMatchObject({ lanes: 1, headroom: 1 });
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
    const r = recommendLanes({ machine, loads, ...free, tuning: { ...DEFAULT_LANE_TUNING, maxLanes: 3 } });
    expect(r).toMatchObject({ lanes: 3, headroom: 4 });
    expect(r.reason).toMatch(/; kept within the bounds 1 to 3$/);
    const low = recommendLanes({ machine, loads: [load(1, { pressured: { cpu: 0, memory: 60, disk: 0 } })], ...free, tuning: DEFAULT_LANE_TUNING });
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

const rec = (over: Partial<LaneRecommendation> = {}): LaneRecommendation => ({
  machineId: 'm', online: true, configured: 2, lanes: 4, headroom: 4, reason: 'r', confidence: 1, usedFrac: 0, usage: 'free', tuning: DEFAULT_LANE_TUNING, ...over,
});
const dismissal = (over: Partial<LaneDismissal> = {}): LaneDismissal => ({ lanes: 4, configured: 2, at: '2026-10-10T12:00:00.000Z', by: 'someone', ...over });
const applied = (over: Partial<LaneChange> = {}): LaneChange => ({ at: '2026-10-10T12:00:00.000Z', machineId: 'm', kind: 'applied', from: 2, to: 4, reason: 'r', by: 'someone', ...over } as LaneChange);

describe('what an admin can do with a recommendation', () => {
  it('apply one that differs from the configured lanes and stands on a known headroom', () => {
    expect(laneActions(rec(), undefined, undefined)).toEqual({ apply: { to: 4 } });
    expect(laneActions(rec({ lanes: 1, headroom: 1 }), undefined, undefined)).toEqual({ apply: { to: 1 } });
  });

  it('nothing to apply: the configured lanes, no headroom known, auto-tune off or offline', () => {
    expect(laneActions(rec({ lanes: 2 }), undefined, undefined)).toEqual({});
    expect(laneActions(rec({ headroom: undefined }), undefined, undefined)).toEqual({});
    expect(laneActions(rec({ tuning: { ...DEFAULT_LANE_TUNING, autoTune: false } }), undefined, undefined)).toEqual({});
    expect(laneActions(rec({ online: false }), undefined, undefined)).toEqual({});
  });

  it('a dismissed recommendation is not offered again until it moves', () => {
    expect(laneActions(rec(), dismissal(), undefined)).toEqual({ dismissed: { at: '2026-10-10T12:00:00.000Z', by: 'someone' } });
    expect(laneActions(rec({ lanes: 3, headroom: 3 }), dismissal(), undefined)).toEqual({ apply: { to: 3 } });
    expect(laneActions(rec(), dismissal({ configured: 3 }), undefined)).toEqual({ apply: { to: 4 } });
  });

  it('undo the last change applied while the configured lanes are still its lanes', () => {
    expect(laneActions(rec({ configured: 4 }), undefined, applied())).toEqual({ undo: { to: 2 } });
    // Edited by hand since: nothing to undo.
    expect(laneActions(rec({ configured: 3, lanes: 3 }), undefined, applied())).toEqual({});
    // The last change was an undo: nothing more to undo.
    expect(laneActions(rec({ configured: 2 }), undefined, applied({ kind: 'undone', from: 4, to: 2 } as Partial<LaneChange>))).toEqual({ apply: { to: 4 } });
  });
});
