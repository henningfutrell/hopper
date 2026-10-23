// Issue #2499 part 9: a seat with a CPU quota whose tasks want more CPU than the quota gives is throttled (cpu.stat
// nr_throttled of nr_periods), while its CPU busy can read as below pressure. A machine throttled in 50% of its periods or
// more since its read before takes no new job, and a wait names it.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { resourcePressure } from '../../src/decider/elbow-in.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const burst = (n: number): Job[] => Array.from({ length: n }, (_, i) => job(`j${i + 1}`));
const throttled = (frac: number, over: Partial<MachineSnapshot> = {}): MachineSnapshot =>
  machine({ maxLanes: 8, resources: { cores: 4, cpuBusyFrac: 0.5, memTotalBytes: 14 * GIB, memAvailableBytes: 12 * GIB, cpuThrottledFrac: frac }, ...over });

describe('CPU throttle (issue #2499)', () => {
  it('a machine throttled in 50% of its CPU periods or more takes no new job, and the wait says why', () => {
    const d = decide(inputs({ machines: [throttled(0.62)], waiting: burst(1) }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toBe('waiting for CPU: local\'s CPU quota held its tasks back in 62% of its periods lately, and a new job starts only below 50%');
  });

  it('below 50% the machine takes the job; a job goes to the machine that is not throttled', () => {
    expect(decide(inputs({ machines: [throttled(0.49)], waiting: burst(1) }), 'd1').start).toHaveLength(1);
    const d = decide(inputs({ machines: [throttled(0.9, { id: 'a' }), throttled(0, { id: 'b' })], waiting: burst(1) }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('a wait names a throttled machine left out beside one short of memory', () => {
    const short = machine({ id: 'a', maxLanes: 8, resources: { cores: 4, memTotalBytes: 14 * GIB, memAvailableBytes: 1 * GIB } });
    const d = decide(inputs({ machines: [short, throttled(0.8, { id: 'b' })], waiting: burst(1) }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toBe('waiting for CPU: b\'s CPU quota held its tasks back in 80% of its periods lately, and a new job starts only below 50%'
      + '; left out: a is short of memory: 1 GiB available, and a new job needs 2 GiB over its floor of 1.4 GiB');
  });

  it('a throttled machine shows resource pressure: no job elbows in there', () => {
    expect(resourcePressure(throttled(0.7))).toBe('CPU throttled in 70% of its periods');
    expect(resourcePressure(throttled(0.2))).toBeUndefined();
  });
});
