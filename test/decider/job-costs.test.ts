// Job cost profiles (issue #688): per finished job, what its runs cost on their machine — one lane's share of CPU,
// memory and disk net of the machine's baseline, peaks and averages —, its duration and the plan usage it burned, and
// the profiles grouped by repository, job cost kind and template.
import { describe, expect, it } from 'vitest';
import { jobCostGroups, jobCostKind, jobCostProfiles } from '../../src/decider/job-costs.ts';
import type { JobCostProfile, JobRun } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const MIN = 60_000;
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * MIN).toISOString();

const run = (jobId: string, from: number, to: number, over: Partial<JobRun> = {}): JobRun => ({
  jobId, machineId: 'm', startedAt: at(from), endedAt: at(to), end: 'finished', samples: to - from, lanesBusyAvg: 1,
  cpu: { avg: 0.1, peak: 0.3 }, memoryBytes: { avg: 2 * GIB, peak: 3 * GIB }, diskBytes: { avg: GIB, peak: GIB }, usage: { five_hour: 0.04 }, ...over,
});

const facts = (id: string) => ({ jobId: id, repo: id === 'b' ? 'o/other' : 'o/r', kind: id === 'c' ? 'research' as const : 'code' as const });

describe('job cost kind', () => {
  it('research, proposal, else code', () => {
    expect(jobCostKind({ executor: 'x', payload: {}, research: true, proposal: true })).toBe('research');
    expect(jobCostKind({ executor: 'x', payload: {}, proposal: true })).toBe('proposal');
    expect(jobCostKind({ executor: 'x', payload: {} })).toBe('code');
  });
});

describe('job cost profiles', () => {
  it('one per job whose last run finished or failed, newest first', () => {
    const p = jobCostProfiles([
      run('a', 0, 30),
      run('b', 40, 50, { end: 'failed' }),
      run('c', 0, 20, { end: 'parked' }),
      run('d', 0, 10, { end: 'cancelled' }),
    ], facts, () => undefined);
    expect(p.map((x) => [x.jobId, x.outcome])).toEqual([['b', 'failed'], ['a', 'finished']]);
    expect(p[1]).toEqual({
      jobId: 'a', repo: 'o/r', kind: 'code', machineId: 'm', outcome: 'finished', finishedAt: at(30), durationMs: 30 * MIN, runs: 1, samples: 30,
      cpu: { avg: 0.1, peak: 0.3 }, memoryBytes: { avg: 2 * GIB, peak: 3 * GIB }, diskBytes: { avg: GIB, peak: GIB }, usage: { five_hour: 0.04 },
    });
  });

  it('adds up a job\'s runs: durations, sample-weighted averages, the highest peak, the usage each lane burned', () => {
    const [p] = jobCostProfiles([
      run('c', 0, 10, { end: 'parked', cpu: { avg: 0.1, peak: 0.2 }, usage: { five_hour: 0.06 }, lanesBusyAvg: 2 }),
      run('c', 20, 50, { machineId: 'n', cpu: { avg: 0.3, peak: 0.5 }, usage: { five_hour: 0.02, week: 0.01 } }),
    ], facts, (m) => (m === 'n' ? 'box' : undefined));
    expect(p).toMatchObject({ jobId: 'c', kind: 'research', machineId: 'n', template: 'box', durationMs: 40 * MIN, runs: 2, samples: 40 });
    expect(p!.cpu!.avg).toBeCloseTo(0.25);
    expect(p!.cpu!.peak).toBe(0.5);
    expect(p!.usage.five_hour).toBeCloseTo(0.05);
    expect(p!.usage.week).toBeCloseTo(0.01);
  });

  it('a resource no sample of a run read is absent; a job the store no longer has is left out', () => {
    const [p] = jobCostProfiles([run('a', 0, 5, { samples: 0, cpu: undefined, memoryBytes: undefined, diskBytes: undefined, usage: {} })], facts, () => undefined);
    expect(p).not.toHaveProperty('cpu');
    expect(p!.usage).toEqual({});
    expect(jobCostProfiles([run('gone', 0, 5)], () => undefined, () => undefined)).toEqual([]);
  });
});

describe('job cost groups', () => {
  const profile = (over: Partial<JobCostProfile>): JobCostProfile => ({
    jobId: 'x', repo: 'o/r', kind: 'code', machineId: 'm', outcome: 'finished', finishedAt: at(0), durationMs: 10 * MIN, runs: 1, samples: 10,
    cpu: { avg: 0.1, peak: 0.2 }, usage: { five_hour: 0.02 }, ...over,
  });

  it('per repository, job cost kind and template: the jobs, the failed, and the mean of each figure, most jobs first', () => {
    const g = jobCostGroups([
      profile({ jobId: 'a' }),
      profile({ jobId: 'b', durationMs: 30 * MIN, cpu: { avg: 0.3, peak: 0.6 }, usage: { five_hour: 0.04 }, outcome: 'failed', template: 'box' }),
      profile({ jobId: 'c', repo: 'o/other', kind: 'research', cpu: undefined, usage: {} }),
    ]);
    expect(g.repo.map((x) => [x.key, x.jobs])).toEqual([['o/r', 2], ['o/other', 1]]);
    expect(g.repo[0]).toMatchObject({ key: 'o/r', jobs: 2, failed: 1, durationMs: 20 * MIN, samples: 20 });
    expect(g.repo[0]!.cpu!.avg).toBeCloseTo(0.2);
    expect(g.repo[0]!.cpu!.peak).toBeCloseTo(0.4);
    expect(g.repo[0]!.usage.five_hour).toBeCloseTo(0.03);
    expect(g.repo[1]).not.toHaveProperty('cpu');
    expect(g.kind.map((x) => [x.key, x.jobs])).toEqual([['code', 2], ['research', 1]]);
    expect(g.template.map((x) => [x.key, x.jobs])).toEqual([['box', 1]]);
  });
});
