// Issue #2291: the memory floor. A machine takes a new job, or a job back, only while its memory available, less the
// memory each job it started lately has yet to take and the memory the new job needs, stays at or above its floor. Below
// the floor the decider pauses the job that started last there (parked, its work kept, queued again), one at a time.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { NOW, busy, inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(new Date(NOW).getTime() - minutes * MINUTE).toISOString();
/** A machine of 14 GiB, as a WSL VM with that cap, with `available` GiB available. */
const vm = (available: number, over: Partial<MachineSnapshot> = {}): MachineSnapshot =>
  machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: available * GIB }, ...over });
const burst = (n: number): Job[] => Array.from({ length: n }, (_, i) => job(`j${i + 1}`));
const run = (id: string, n: number, startedMinutesAgo: number, over: Partial<Job> = {}): Job =>
  job(id, { status: 'running', startedAt: ago(startedMinutesAgo), agentSession: `session-${id}`, laneId: `local/lane-${n}`, ...over });

describe('the memory floor (issue #2291)', () => {
  it('a burst of 7 jobs starts only as many as the memory holds; the rest wait for memory', () => {
    // 11 GiB available, the floor 1.4 GiB (10% of 14), 2 GiB a job: 4 jobs fit, a 5th would leave 1.4 - 0.4.
    const d = decide(inputs({ machines: [vm(11)], waiting: burst(7) }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['j1', 'j2', 'j3', 'j4']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['j5', 'j6', 'j7']);
    expect(d.wait[0]!.reason).toBe('waiting for memory: local has 11 GiB available, 8 GiB of it kept for 4 jobs started lately, and a new job needs 2 GiB over its floor of 1.4 GiB');
  });

  it('counts the jobs it started lately: their memory is not taken yet', () => {
    const lately = [run('r1', 1, 3), run('r2', 2, 9)];
    const d = decide(inputs({ machines: [vm(11)], lanes: [busy(1, 'r1'), busy(2, 'r2')], running: lately, waiting: burst(7) }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['j1', 'j2']);
  });

  it('a job that started over 10 minutes ago has taken its memory: it reserves none', () => {
    const settled = [run('r1', 1, 11), run('r2', 2, 40)];
    const d = decide(inputs({ machines: [vm(11)], lanes: [busy(1, 'r1'), busy(2, 'r2')], running: settled, waiting: burst(7) }), 'd1');
    expect(d.start).toHaveLength(4);
  });

  it('below the floor plus one job, nothing starts there, and a job resuming there waits too', () => {
    const d = decide(inputs({ machines: [vm(3)], waiting: [job('new'), job('back', { pendingAnswer: 'go on', resumeOn: 'local' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait.map((w) => w.jobId).sort()).toEqual(['back', 'new']);
  });

  it('a job goes to the machine whose memory holds it', () => {
    const d = decide(inputs({ machines: [vm(2, { id: 'a' }), vm(12, { id: 'b' })], waiting: [job('j')] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('a machine\'s own floor and memory for a job count; a floor of 0 turns it off', () => {
    const own = decide(inputs({ machines: [vm(11, { memoryFloor: { floorGiB: 3, perJobGiB: 4 } })], waiting: burst(7) }), 'd1');
    expect(own.start).toHaveLength(2);
    const off = decide(inputs({ machines: [vm(1, { memoryFloor: { floorGiB: 0 } })], waiting: burst(3) }), 'd1');
    expect(off.start).toHaveLength(3);
  });

  it('a machine with no memory reading takes jobs as before', () => {
    const d = decide(inputs({ machines: [machine({ maxLanes: 8 })], waiting: burst(7) }), 'd1');
    expect(d.start).toHaveLength(7);
  });

  it('a job whose expected memory peak is more than the memory for a job reserves its peak', () => {
    const expectedCosts = { j1: { group: 'repo' as const, key: 'o/r', jobs: 5, memoryBytes: { avg: 3 * GIB, peak: 5 * GIB } } };
    const d = decide(inputs({ machines: [vm(9)], waiting: burst(3), expectedCosts }), 'd1');
    // 9 - 1.4 = 7.6 GiB: j1 takes 5, j2 takes 2, j3 waits.
    expect(d.start.map((s) => s.jobId)).toEqual(['j1', 'j2']);
  });

  it('on WSL, Windows\' free memory counts when it is lower', () => {
    const wsl = vm(11, { resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 11 * GIB, wsl: true, hostMemFreeBytes: 4 * GIB, hostMemTotalBytes: 32 * GIB } });
    const d = decide(inputs({ machines: [wsl], waiting: burst(7) }), 'd1');
    expect(d.start).toHaveLength(1);
  });

  it('a job of higher priority that waits for memory preempts nothing', () => {
    const d = decide(inputs({
      machines: [vm(2, { maxLanes: 1 })], lanes: [busy(1, 'r1')], running: [run('r1', 1, 30)],
      waiting: [job('high', { priority: 75 })], preemption: { minRunMs: 0, parkingExecutors: ['test'] },
    }), 'd1');
    expect(d.preempt).toBeUndefined();
  });
});

describe('a memory pause (issue #2291)', () => {
  const two = { lanes: [busy(1, 'r1'), busy(2, 'r2')], running: [run('r1', 1, 30), run('r2', 2, 5)], parkingExecutors: ['test'] };

  it('below the floor, the job that started last there is paused', () => {
    const d = decide(inputs({ machines: [vm(1)], ...two }), 'd1');
    expect(d.memoryPause).toEqual([{
      jobId: 'r2', laneId: 'local/lane-2', machineId: 'local', availableBytes: 1 * GIB, floorBytes: 1.4 * GIB,
      reason: 'pauses r2 on local/lane-2: local has 1 GiB available, below its floor of 1.4 GiB; r2 started there last',
    }]);
    expect(d.reasons).toContain(d.memoryPause![0]!.reason);
  });

  it('at or above the floor, nothing is paused', () => {
    expect(decide(inputs({ machines: [vm(1.5)], ...two }), 'd1').memoryPause).toBeUndefined();
  });

  it('one at a time: no second pause there while one is less than 2 minutes old', () => {
    const recent = job('p', { status: 'queued', resumeOn: 'local', memoryPaused: { at: ago(1), machineId: 'local', availableBytes: GIB, floorBytes: 1.4 * GIB } });
    expect(decide(inputs({ machines: [vm(1)], ...two, waiting: [recent] }), 'd1').memoryPause).toBeUndefined();
    const older = { ...recent, memoryPaused: { ...recent.memoryPaused!, at: ago(3) } };
    expect(decide(inputs({ machines: [vm(1)], ...two, waiting: [older] }), 'd1').memoryPause?.map((p) => p.jobId)).toEqual(['r2']);
    const inFlight = { ...two, running: [run('r1', 1, 30), run('r2', 2, 5, { memoryPaused: { at: ago(1), machineId: 'local', availableBytes: GIB, floorBytes: 1.4 * GIB } })] };
    expect(decide(inputs({ machines: [vm(1)], ...inFlight }), 'd1').memoryPause).toBeUndefined();
    // Parked and not queued again yet, the paused job is no input: the hopper's own record of the pause counts.
    expect(decide(inputs({ machines: [vm(1)], ...two, memoryPausedAt: { local: ago(1) } }), 'd1').memoryPause).toBeUndefined();
    expect(decide(inputs({ machines: [vm(1)], ...two, memoryPausedAt: { local: ago(3) } }), 'd1').memoryPause).toHaveLength(1);
  });

  it('never a job whose executor cannot park, or one with no agent session to resume', () => {
    expect(decide(inputs({ machines: [vm(1)], ...two, parkingExecutors: [] }), 'd1').memoryPause).toBeUndefined();
    const noSession = { ...two, running: [run('r1', 1, 30), run('r2', 2, 5, { agentSession: undefined })] };
    expect(decide(inputs({ machines: [vm(1)], ...noSession }), 'd1').memoryPause?.map((p) => p.jobId)).toEqual(['r1']);
  });

  it('a floor of 0, or no reading, pauses nothing', () => {
    expect(decide(inputs({ machines: [vm(1, { memoryFloor: { floorGiB: 0 } })], ...two }), 'd1').memoryPause).toBeUndefined();
    expect(decide(inputs({ machines: [machine({ maxLanes: 8 })], ...two }), 'd1').memoryPause).toBeUndefined();
  });
});

describe('a wait release (issues #2303, #2326)', () => {
  const session = (jobId: string, since: number, machineId = 'local') => ({ jobId, machineId, since: ago(since) });

  it('ends the agent of every job on its own wait, on every machine, the oldest wait first', () => {
    const d = decide(inputs({ machines: [vm(3)], waiting: [job('new')], waitSessions: [session('w2', 5), session('w1', 30), session('far', 40, 'other')] }), 'd1');
    expect(d.wait.map((w) => w.jobId)).toEqual(['new']);
    expect(d.waitRelease).toEqual([
      { jobId: 'far', machineId: 'other', reason: 'releases the agent of far on other: it waits on its own since 40 min ago, and a waiting job holds no agent; it resumes its session when its wait ends, on any machine with room' },
      { jobId: 'w1', machineId: 'local', reason: 'releases the agent of w1 on local: it waits on its own since 30 min ago, and a waiting job holds no agent; it resumes its session when its wait ends, on any machine with room' },
      { jobId: 'w2', machineId: 'local', reason: 'releases the agent of w2 on local: it waits on its own since 5 min ago, and a waiting job holds no agent; it resumes its session when its wait ends, on any machine with room' },
    ]);
    expect(d.reasons).toEqual(expect.arrayContaining(d.waitRelease!.map((r) => r.reason)));
  });

  it('ends them while every job fits the memory, and with nothing queued', () => {
    expect(decide(inputs({ machines: [vm(11)], waiting: [job('new')], waitSessions: [session('w1', 30)] }), 'd1').waitRelease?.map((r) => r.jobId)).toEqual(['w1']);
    expect(decide(inputs({ machines: [vm(11)], waiting: [], waitSessions: [session('w1', 30)] }), 'd1').waitRelease?.map((r) => r.jobId)).toEqual(['w1']);
    expect(decide(inputs({ machines: [vm(11)], waiting: [] }), 'd1').waitRelease).toBeUndefined();
  });

  it('ends none whose wait is less than 5 seconds old', () => {
    const fresh = { jobId: 'w0', machineId: 'local', since: new Date(new Date(NOW).getTime() - 4_000).toISOString() };
    expect(decide(inputs({ machines: [vm(3)], waiting: [], waitSessions: [fresh, session('w1', 1)] }), 'd1').waitRelease?.map((r) => r.jobId)).toEqual(['w1']);
  });
});

// Issue #2499: real per-seat limits and per-job demand from history.
describe('the memory floor on a seat, and a job\'s demand from its history (issue #2499)', () => {
  it('a seat at 90% of its cgroup limit takes no new job, though the VM it runs in has free memory', () => {
    const seat = machine({ id: 'seat', maxLanes: 3, resources: { cores: 2, memTotalBytes: 4 * GIB, memAvailableBytes: 0.4 * GIB, container: true, wsl: true, hostMemFreeBytes: 8 * GIB } });
    const d = decide(inputs({ machines: [seat], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toMatch(/^waiting for memory: seat has 0\.4 GiB available/);
  });

  it('a repository whose jobs peaked at 3 GiB reserves 3 GiB a job, not the flat 2 GiB', () => {
    const cost = { group: 'repo' as const, key: 'o/gradle', jobs: 5, memoryBytes: { avg: 2 * GIB, peak: 3 * GIB } };
    // 8 GiB available, the floor 1.4 GiB: two jobs of 3 GiB fit (1.4 + 6 ≤ 8), a third does not; at 2 GiB a third would.
    const d = decide(inputs({ machines: [vm(8)], waiting: burst(3), expectedCosts: { j1: cost, j2: cost, j3: cost } }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['j1', 'j2']);
    expect(d.wait[0]!.reason).toMatch(/a new job needs 3 GiB over its floor/);
  });

  it('the memory a waiting job\'s scope holds is counted, and its wait names it', () => {
    const resources = { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 3 * GIB, jobMemoryBytes: { w1: 2.5 * GIB, r1: 1 * GIB } };
    const d = decide(inputs({ machines: [machine({ maxLanes: 8, resources })], lanes: [busy(1, 'r1')], running: [run('r1', 1, 30)], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toBe('waiting for memory: local has 3 GiB available (2.5 GiB is held by 1 job with no lane), and a new job needs 2 GiB over its floor of 1.4 GiB');
  });
});

// Issue #2499 part 4: machines whose readings name one kernel (its boot id) share that kernel's memory: a host pool.
describe('a host pool (issue #2499)', () => {
  /** A seat in a container with a 4 GiB limit and 3.5 GiB of it available, on the kernel `boot`, which has `kernel` GiB available of 14. */
  const seat = (id: string, kernel: number, boot = 'boot-1', over: Partial<MachineSnapshot['resources'] & object> = {}): MachineSnapshot => machine({
    id, maxLanes: 3,
    resources: { cores: 2, memTotalBytes: 4 * GIB, memAvailableBytes: 3.5 * GIB, container: true, bootId: boot, kernelMemTotalBytes: 14 * GIB, kernelMemAvailableBytes: kernel * GIB, ...over },
  });

  it('two seats on one kernel take only as many jobs as the kernel\'s memory holds, each with room of its own', () => {
    // Each seat alone: 3.5 - 2 >= its floor of 1 GiB. The kernel: 4 GiB available, its floor 1.4 GiB: one job, not two.
    const d = decide(inputs({ machines: [seat('a', 4), seat('b', 4)], waiting: burst(2) }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['j1']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['j2']);
    expect(d.wait[0]!.reason).toMatch(/^waiting for memory: /);
    // The seat that took j1 is short of its own memory; the other is short of the host's.
    expect(d.wait[0]!.reason).toMatch(/(a's host \(shared with b\)|b's host \(shared with a\)) has 4 GiB available, 2 GiB of it kept for 1 job started lately, and a new job needs 2 GiB over its floor of 1\.4 GiB/);
  });

  it('seats on different kernels are not pooled', () => {
    const d = decide(inputs({ machines: [seat('a', 4, 'boot-1'), seat('b', 4, 'boot-2')], waiting: burst(2) }), 'd1');
    expect(d.start).toHaveLength(2);
  });

  it('Windows\' free memory that one machine of the pool reads counts for every machine of it', () => {
    const local = machine({ id: 'local', maxLanes: 3, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB, wsl: true, bootId: 'boot-1', hostMemFreeBytes: 3 * GIB, hostMemTotalBytes: 32 * GIB } });
    // The seat has room of its own and the kernel has 10 GiB, but Windows has 3 GiB free: 3 - 2 < 1.4.
    const d = decide(inputs({ machines: [local, seat('a', 10, 'boot-1', { wsl: true })], waiting: burst(1) }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toContain("a's host (shared with local) has 3 GiB available");
  });

  it('one machine alone on its kernel, not in a container, is no pool: its own floor decides, also when it is off', () => {
    const off = machine({ maxLanes: 3, memoryFloor: { floorGiB: 0 }, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 1 * GIB, bootId: 'boot-1' } });
    expect(decide(inputs({ machines: [off], waiting: burst(2) }), 'd1').start).toHaveLength(2);
  });

  it('one seat alone in a container is checked against its kernel too', () => {
    const d = decide(inputs({ machines: [seat('a', 3)], waiting: burst(1) }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toBe("waiting for memory: a's host has 3 GiB available, and a new job needs 2 GiB over its floor of 1.4 GiB");
  });
});
