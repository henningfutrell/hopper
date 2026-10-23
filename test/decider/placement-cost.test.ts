// Placement by expected cost (issue #688): a waiting job's expected cost is the job cost group it falls in — its
// repository's, else its job cost kind's — with enough jobs. A machine where that cost would bring memory or CPU to
// resource pressure is passed over for one where it fits; when it fits nowhere, the job is placed as before.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { expectedCost } from '../../src/decider/placement-cost.ts';
import type { ExpectedCost, Job, JobCostGroup, ResourceReading } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const group = (key: string, jobs: number, memPeakGib: number, cpuAvg = 0.1): JobCostGroup => ({
  key, jobs, failed: 0, durationMs: 60_000, samples: 10 * jobs,
  cpu: { avg: cpuAvg, peak: cpuAvg * 2 }, memoryBytes: { avg: (memPeakGib / 2) * GIB, peak: memPeakGib * GIB }, usage: {},
});
const res = (availGib: number, cpuBusyFrac = 0.1): ResourceReading => ({ cores: 8, cpuBusyFrac, memTotalBytes: 16 * GIB, memAvailableBytes: availGib * GIB });
const cost = (memPeakGib: number, cpuAvg = 0.1): ExpectedCost => ({
  group: 'repo', key: 'o/r', jobs: 3, cpu: { avg: cpuAvg, peak: cpuAvg * 2 }, memoryBytes: { avg: (memPeakGib / 2) * GIB, peak: memPeakGib * GIB },
});
const withRepo = (id: string, repo?: string, research = false): Job => {
  const j = job(id, repo ? { source: { source: 'github', kind: 'github', key: id, repo } } : {});
  return research ? { ...j, spec: { ...j.spec, research: true as const } } : j;
};

describe('a job\'s expected cost', () => {
  const groups = { repo: [group('o/r', 3, 2), group('o/few', 2, 9)], kind: [group('code', 5, 4), group('research', 1, 1)] };

  it('is its repository\'s group when that group has 3 jobs or more', () => {
    expect(expectedCost(withRepo('j', 'o/r'), groups)).toMatchObject({ group: 'repo', key: 'o/r', jobs: 3, memoryBytes: { peak: 2 * GIB } });
  });

  it('is its job cost kind\'s group when its repository has too few jobs or none', () => {
    expect(expectedCost(withRepo('j', 'o/few'), groups)).toMatchObject({ group: 'kind', key: 'code', jobs: 5 });
    expect(expectedCost(withRepo('j'), groups)).toMatchObject({ group: 'kind', key: 'code' });
  });

  it('is unknown when neither group has enough jobs', () => {
    expect(expectedCost(withRepo('j', undefined, true), groups)).toBeUndefined();
    expect(expectedCost(withRepo('j', 'o/r'), { repo: [], kind: [] })).toBeUndefined();
  });
});

describe('placement by expected cost', () => {
  const two = (a: ResourceReading | undefined, b: ResourceReading | undefined) => [
    machine({ id: 'a', label: 'a', ...(a ? { resources: a } : {}) }), machine({ id: 'b', label: 'b', ...(b ? { resources: b } : {}) }),
  ];

  it('without an expected cost, the job goes where it went before: the lowest id among equals', () => {
    const d = decide(inputs({ machines: two(res(4), res(12)), waiting: [job('j')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'j', machineId: 'a' })]);
    expect(d.start[0]!.reason).not.toContain('expected cost');
  });

  it('passes over a machine where its memory peak would reach memory pressure', () => {
    const d = decide(inputs({ machines: two(res(4), res(12)), waiting: [job('j')], expectedCosts: { j: cost(3) } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'j', machineId: 'b' })]);
    expect(d.start[0]!.reason).toContain('expected cost (repo o/r, 3 jobs): memory peak 3 GiB, CPU 10%');
  });

  it('passes over a machine where its CPU would reach CPU pressure', () => {
    const d = decide(inputs({ machines: two(res(12, 0.9), res(12, 0.2)), waiting: [job('j')], expectedCosts: { j: cost(1, 0.1) } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ machineId: 'b' })]);
  });

  it('a machine with no resource reading is not passed over', () => {
    const d = decide(inputs({ machines: two(undefined, res(12)), waiting: [job('j')], expectedCosts: { j: cost(3) } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ machineId: 'a' })]);
  });

  it('the jobs placed in the same Decision count: a second job whose memory peak no machine holds waits for memory (issue #2291)', () => {
    const d = decide(inputs({ machines: two(res(4), res(12)), waiting: [job('j1'), job('j2')], expectedCosts: { j1: cost(6), j2: cost(6) } }), 'd1');
    expect(d.start.map((s) => [s.jobId, s.machineId])).toEqual([['j1', 'b']]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['j2']);
    expect(d.wait[0]!.reason).toMatch(/^waiting for memory: a has 4 GiB available, and a new job needs 6 GiB over its floor of 1.6 GiB; b has 12 GiB available, 6 GiB of it kept for 1 job started lately/);
  });

  it('a job whose CPU fits no machine is placed as before, and says so', () => {
    const d = decide(inputs({ machines: two(res(12, 0.85), res(12, 0.85)), waiting: [job('j')], expectedCosts: { j: cost(1, 0.1) } }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['a']);
    expect(d.start[0]!.reason).toContain('expected cost (repo o/r, 3 jobs): memory peak 1 GiB, CPU 10%, fits no machine');
  });
});
