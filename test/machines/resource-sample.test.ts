// Issue #2499: a machine sample counts the memory its job scopes hold for jobs with no lane in use there — a job on its own
// wait, parked, or queued to resume —, so that memory is not taken for the running jobs'.
import { describe, expect, it } from 'vitest';
import type { DiskMeasure } from '../../src/domain/types.ts';
import { sampleOf } from '../../src/machines/history.ts';
import { busy, machine } from '../decider/support.ts';

const GIB = 1024 ** 3;
const AT = '2026-10-22T12:00:00.000Z';

describe('a machine sample (issue #2499)', () => {
  it('counts the memory of the job scopes with no lane in use there as waiting memory', () => {
    const m = machine({ maxLanes: 3, resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 3 * GIB, jobMemoryBytes: { w1: 2 * GIB, w2: GIB, r1: GIB } } });
    expect(sampleOf(m, [busy(1, 'r1'), busy(1, 'x', { machineId: 'other' })], AT)).toMatchObject({ waitingMemBytes: 3 * GIB, lanesBusy: 1 });
  });

  it('no scopes read: no waiting memory', () => {
    const m = machine({ resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 3 * GIB } });
    expect(sampleOf(m, [], AT)).not.toHaveProperty('waitingMemBytes');
  });

  it('keeps its memory pressure (some, as a share) and its CPU throttle; not read, none', () => {
    const m = machine({ resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 3 * GIB, memPressure: { someAvg10: 23.5, fullAvg10: 4 }, cpuThrottledFrac: 0.62 } });
    expect(sampleOf(m, [], AT)).toMatchObject({ memPressureFrac: 0.235, cpuThrottledFrac: 0.62 });
    const none = sampleOf(machine({ resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 3 * GIB } }), [], AT);
    expect(none).not.toHaveProperty('memPressureFrac');
    expect(none).not.toHaveProperty('cpuThrottledFrac');
  });
});

// Issue #2494: a machine sample keeps the hopper's own disk use and its caches, from the sweep's last measure there.
describe('a machine sample\'s disk use (issue #2494)', () => {
  const disk = { disk: { freeBytes: 40 * GIB, totalBytes: 100 * GIB, low: false } };
  const measure = (at: string): DiskMeasure => ({
    at, paths: [{ path: '/w/.worktrees/@scratch', bytes: 3 * GIB }, { path: '/w/.worktrees/hopper', bytes: 7 * GIB }],
    caches: [{ kind: 'cache', path: '/h/.cache', bytes: 5 * GIB }, { kind: 'pip', path: '/h/.cache/pip', bytes: 2 * GIB }, { kind: 'go', path: '/h/go/pkg/mod', bytes: 4 * GIB }],
  });

  it('keeps the hopper\'s own use (its places summed) and the caches (a cache inside ~/.cache counted once)', () => {
    expect(sampleOf(machine(disk), [], AT, measure('2026-10-22T11:30:00.000Z'))).toMatchObject({ hopperDiskBytes: 10 * GIB, cacheDiskBytes: 9 * GIB, diskTotalBytes: 100 * GIB });
  });

  it('a measure more than an hour old, or none: no disk use', () => {
    for (const m of [measure('2026-10-22T10:59:00.000Z'), undefined]) {
      const s = sampleOf(machine(disk), [], AT, m);
      expect(s).not.toHaveProperty('hopperDiskBytes');
      expect(s).not.toHaveProperty('cacheDiskBytes');
    }
  });

  it('a measure with no caches: the hopper\'s use only', () => {
    const s = sampleOf(machine(disk), [], AT, { ...measure(AT), caches: [] });
    expect(s).toMatchObject({ hopperDiskBytes: 10 * GIB });
    expect(s).not.toHaveProperty('cacheDiskBytes');
  });
});
