// Issue #2499: a machine sample counts the memory its job scopes hold for jobs with no lane in use there — a job on its own
// wait, parked, or queued to resume —, so that memory is not taken for the running jobs'.
import { describe, expect, it } from 'vitest';
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
