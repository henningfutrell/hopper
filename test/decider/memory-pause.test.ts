// Issue #2499: the memory pause reads more than a machine's own memory. Seats on one kernel each had memory of their own
// while the kernel they share had none, and a seat near its cgroup limit stalls on memory while it reads memory available.
// So a host pool below its floor pauses the job that started last on any of its machines, one at a time for the pool, and a
// machine whose memory pressure is at or above MEMORY_PRESSURE_PAUSE_PERCENT pauses the job that started there last.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { NOW, busy, inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(new Date(NOW).getTime() - minutes * MINUTE).toISOString();
const run = (id: string, laneId: string, startedMinutesAgo: number, over: Partial<Job> = {}): Job =>
  job(id, { status: 'running', startedAt: ago(startedMinutesAgo), agentSession: `session-${id}`, laneId, ...over });

describe('a memory pause on a host pool (issue #2499)', () => {
  /** A seat in a container with a 4 GiB limit and 3 GiB of it available, on the kernel `boot`, which has `kernel` GiB available of 14. */
  const seat = (id: string, kernel: number, boot = 'boot-1'): MachineSnapshot => machine({
    id, maxLanes: 3,
    resources: { cores: 2, memTotalBytes: 4 * GIB, memAvailableBytes: 3 * GIB, container: true, bootId: boot, kernelMemTotalBytes: 14 * GIB, kernelMemAvailableBytes: kernel * GIB },
  });
  const twoSeats = {
    lanes: [busy(1, 'r1', { machineId: 'a' }), busy(1, 'r2', { machineId: 'b' })],
    running: [run('r1', 'a/lane-1', 30), run('r2', 'b/lane-1', 5)], parkingExecutors: ['test'],
  };

  it('below the kernel\'s floor, the job that started last on any machine of the pool is paused, though each has memory of its own', () => {
    const d = decide(inputs({ machines: [seat('a', 1), seat('b', 1)], ...twoSeats }), 'd1');
    expect(d.memoryPause).toEqual([{
      jobId: 'r2', laneId: 'b/lane-1', machineId: 'b', availableBytes: 1 * GIB, floorBytes: 1.4 * GIB,
      reason: 'pauses r2 on b/lane-1: the host of a, b has 1 GiB available, below its floor of 1.4 GiB; r2 started there last',
    }]);
  });

  it('at or above the kernel\'s floor, or on two kernels, nothing is paused', () => {
    expect(decide(inputs({ machines: [seat('a', 1.5), seat('b', 1.5)], ...twoSeats }), 'd1').memoryPause).toBeUndefined();
    expect(decide(inputs({ machines: [seat('a', 1, 'boot-1'), seat('b', 1, 'boot-2')], ...twoSeats }), 'd1').memoryPause?.map((p) => p.jobId)).toEqual(['r1', 'r2']);
  });

  it('one pause at a time for the pool: a pause on any machine of it less than 2 minutes old holds the next', () => {
    expect(decide(inputs({ machines: [seat('a', 1), seat('b', 1)], ...twoSeats, memoryPausedAt: { a: ago(1) } }), 'd1').memoryPause).toBeUndefined();
    const recent = job('p', { status: 'queued', resumeOn: 'a', memoryPaused: { at: ago(1), machineId: 'a', availableBytes: GIB, floorBytes: 1.4 * GIB } });
    expect(decide(inputs({ machines: [seat('a', 1), seat('b', 1)], ...twoSeats, waiting: [recent] }), 'd1').memoryPause).toBeUndefined();
    expect(decide(inputs({ machines: [seat('a', 1), seat('b', 1)], ...twoSeats, memoryPausedAt: { a: ago(3) } }), 'd1').memoryPause).toHaveLength(1);
  });

  it('a machine below its own floor pauses for itself, and the pool pauses no second job in the same Decision', () => {
    const low = machine({ ...seat('a', 1), resources: { ...seat('a', 1).resources!, memAvailableBytes: 0.2 * GIB } });
    const d = decide(inputs({ machines: [low, seat('b', 1)], ...twoSeats }), 'd1');
    expect(d.memoryPause?.map((p) => p.jobId)).toEqual(['r1']);
  });
});

describe('a memory pause on memory pressure (issue #2499)', () => {
  const pressed = (some: number, over: Partial<MachineSnapshot> = {}): MachineSnapshot =>
    machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 4 * GIB, memAvailableBytes: 3 * GIB, memPressure: { someAvg10: some, fullAvg10: 1 } }, ...over });
  const two = { lanes: [busy(1, 'r1'), busy(2, 'r2')], running: [run('r1', 'local/lane-1', 30), run('r2', 'local/lane-2', 5)], parkingExecutors: ['test'] };

  it('a machine whose tasks waited on memory 40% of the last 10 s or more pauses the job that started there last', () => {
    const d = decide(inputs({ machines: [pressed(45)], ...two }), 'd1');
    expect(d.memoryPause).toEqual([{
      jobId: 'r2', laneId: 'local/lane-2', machineId: 'local', availableBytes: 3 * GIB, floorBytes: 1 * GIB,
      reason: "pauses r2 on local/lane-2: local's memory is under pressure: its tasks waited on memory 45% of the last 10 s, at or above 40%; r2 started there last",
    }]);
  });

  it('below 40% nothing is paused, though no new job starts there', () => {
    expect(decide(inputs({ machines: [pressed(30)], ...two }), 'd1').memoryPause).toBeUndefined();
  });

  it('a floor of 0 turns the pressure pause off too', () => {
    expect(decide(inputs({ machines: [pressed(80, { memoryFloor: { floorGiB: 0 } })], ...two }), 'd1').memoryPause).toBeUndefined();
  });
});
