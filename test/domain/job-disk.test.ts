// What each job takes on a machine (issue #2494), from the survey's measures of its scratch dir and its worktrees: pure.
import { describe, expect, it } from 'vitest';
import { hopperDiskOf, jobDiskOf, KEPT_JOB_DISKS } from '../../src/domain/hopper-disk.ts';

const at = '2026-10-23T10:00:00.000Z';

describe('jobDiskOf', () => {
  it('sums each job\'s worktrees and scratch dir, biggest first', () => {
    expect(jobDiskOf([
      { jobId: 'job-a', kind: 'tree', path: '/w/.worktrees/app/job-a', bytes: 300 },
      { jobId: 'job-b', kind: 'tree', path: '/w/.worktrees/app/job-b', bytes: 500 },
      { jobId: 'job-a', kind: 'scratch', path: '/w/.worktrees/@scratch/job-a', bytes: 400 },
      { jobId: 'job-a', kind: 'tree', path: '/w/.worktrees/lib/job-a', bytes: 100 },
    ])).toEqual([
      { jobId: 'job-a', bytes: 800, worktreeBytes: 400, scratchBytes: 400 },
      { jobId: 'job-b', bytes: 500, worktreeBytes: 500, scratchBytes: 0 },
    ]);
  });

  it('keeps only the biggest, so a machine with many jobs left keeps a short measure', () => {
    const many = Array.from({ length: KEPT_JOB_DISKS + 5 }, (_, i) => ({ jobId: `job-${i}`, kind: 'tree' as const, path: `/w/.worktrees/app/job-${i}`, bytes: i + 1 }));
    const kept = jobDiskOf(many);
    expect(kept).toHaveLength(KEPT_JOB_DISKS);
    expect(kept[0]!.jobId).toBe(`job-${KEPT_JOB_DISKS + 4}`);
  });
});

describe('hopperDiskOf with the jobs', () => {
  it('carries each job\'s bytes beside the places', () => {
    const jobs = [{ jobId: 'job-a', bytes: 8, worktreeBytes: 8, scratchBytes: 0 }];
    expect(hopperDiskOf([{ path: '/w/.worktrees', bytes: 10 }], at, undefined, { jobs })).toEqual({ bytes: 10, at, paths: [{ path: '/w/.worktrees', bytes: 10 }], over: false, jobs });
    expect(hopperDiskOf([{ path: '/w/.worktrees', bytes: 10 }], at, undefined, { jobs: [] })).toEqual({ bytes: 10, at, paths: [{ path: '/w/.worktrees', bytes: 10 }], over: false });
  });
});
