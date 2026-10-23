// Issue #2499: lane tuning reads what a machine's memory holds. A machine's memory lanes are how many jobs of a job's
// memory fit in its memory over its floor; on a host pool, in the kernel's memory over the pool's floor, less what the
// configured lanes of the pool's other machines need. The lane recommendation is never more than that.
import { describe, expect, it } from 'vitest';
import { recommendLanes } from '../../src/decider/lane-tuning.ts';
import { memoryLaneCaps } from '../../src/decider/memory-floor.ts';
import { DEFAULT_LANE_TUNING, type LaneLoad, type MachineSnapshot, type ResourceReading } from '../../src/domain/types.ts';
import { machine } from './support.ts';

const GIB = 1024 ** 3;
const reading = (over: Partial<ResourceReading> = {}): ResourceReading => ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB, ...over });
const vm = (id: string, lanes: number, over: Partial<ResourceReading> = {}, m: Partial<MachineSnapshot> = {}): MachineSnapshot =>
  machine({ id, maxLanes: lanes, resources: reading(over), ...m });

describe('memory lanes (issue #2499)', () => {
  it('a machine\'s memory over its floor, at a job\'s memory a lane', () => {
    // 14 GiB less its floor of 1.4 GiB is 12.6 GiB: 6 jobs of 2 GiB.
    const caps = memoryLaneCaps([vm('a', 9)]);
    expect(caps.get('a')).toEqual({ lanes: 6, why: 'its memory holds 6 jobs: 14 GiB less its floor of 1.4 GiB, at 2 GiB a job' });
  });

  it('reads the machine\'s own floor and a job\'s memory, and none with no reading or a floor of 0', () => {
    expect(memoryLaneCaps([vm('a', 9, {}, { memoryFloor: { floorGiB: 2, perJobGiB: 3 } })]).get('a')?.lanes).toBe(4);
    expect(memoryLaneCaps([machine({ id: 'b' })]).has('b')).toBe(false);
    expect(memoryLaneCaps([vm('c', 9, {}, { memoryFloor: { floorGiB: 0 } })]).has('c')).toBe(false);
  });

  it('on a host pool, the kernel\'s memory less what the other machines\' configured lanes need', () => {
    // Two seats of 12 GiB each on a 14 GiB kernel: each one's own memory holds 5 jobs (12 less its floor of 1.2 GiB).
    // The kernel holds 6; b is configured with 2 lanes (4 GiB), so a may have 4; a has 3 (6 GiB), so b may have 3.
    const seat = (id: string, lanes: number, limit: number): MachineSnapshot => vm(id, lanes, {
      container: true, memTotalBytes: limit * GIB, bootId: 'k1', kernelMemTotalBytes: 14 * GIB, kernelMemAvailableBytes: 8 * GIB,
    });
    const caps = memoryLaneCaps([seat('a', 3, 12), seat('b', 2, 12), vm('c', 2, { bootId: 'k2' })]);
    expect(caps.get('a')).toEqual({ lanes: 4, why: 'its host (shared with b) holds 4 jobs: 14 GiB less its floor of 1.4 GiB and 4 GiB for the 2 lanes of b, at 2 GiB a job' });
    expect(caps.get('b')?.lanes).toBe(3);
    expect(caps.get('c')?.lanes).toBe(6);
  });

  it('the configured lanes count, not the lanes lane tuning applied in active mode', () => {
    const seat = (id: string, lanes: number, configured?: number): MachineSnapshot => vm(id, lanes, { bootId: 'k1' }, configured !== undefined ? { configuredLanes: configured } : {});
    expect(memoryLaneCaps([seat('a', 2), seat('b', 1, 3)]).get('a')?.lanes).toBe(3);
  });
});

/** Lane load of `m`: no pressure, and room for 2 more lanes past the most seen. */
const load = (lanesBusy: number): LaneLoad => ({
  machineId: 'm', lanesBusy, samples: 60, pressured: { cpu: 0, memory: 0, disk: 0 }, cpuAvg: 0.1 * lanesBusy, memUsedAvgBytes: lanesBusy * GIB, memTotalBytes: 64 * GIB,
});
const input = { machine: { id: 'm', online: true, maxLanes: 3 }, loads: [load(0), load(3)], progress: [], usedFrac: 0.2, soft: 0.7, hard: 0.95, tuning: DEFAULT_LANE_TUNING };

describe('a lane recommendation the memory holds (issue #2499)', () => {
  it('no more lanes than the machine\'s memory holds, and says why', () => {
    expect(recommendLanes(input)).toMatchObject({ lanes: 5, headroom: 5 });
    const r = recommendLanes({ ...input, memory: { lanes: 2, why: 'its memory holds 2 jobs: 6 GiB less its floor of 1 GiB, at 2 GiB a job' } });
    expect(r).toMatchObject({ lanes: 2, headroom: 5 });
    expect(r.reason).toMatch(/; its memory holds 2 jobs: 6 GiB less its floor of 1 GiB, at 2 GiB a job: no more than 2 lanes$/);
  });

  it('memory that holds more lanes than the headroom changes nothing', () => {
    const r = recommendLanes({ ...input, memory: { lanes: 9, why: 'x' } });
    expect(r.lanes).toBe(5);
    expect(r.reason).not.toMatch(/x/);
  });

  it('the bounds still hold: a memory of no job keeps the least lanes', () => {
    expect(recommendLanes({ ...input, memory: { lanes: 0, why: 'none' } }).lanes).toBe(DEFAULT_LANE_TUNING.minLanes);
  });
});
