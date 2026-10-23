// Issue #2504 part 10: the bytes of the cleanup leftovers on a machine, from the sweep's last disk measure of each job — its
// scratch dir's bytes for a leftover scratch dir or container runtime, its worktrees' for a leftover job worktree. Pure.
import { describe, expect, it } from 'vitest';
import { machineLeftoversOf, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-22T10:00:00.000Z';
const entry = (jobId: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId, machineId: 'm1', kind, locator: `/w/.worktrees/@scratch/${jobId}`, createdAt: AT, state: 'live', ...over });
const disk = (jobId: string, worktreeBytes: number, scratchBytes: number) => ({ jobId, bytes: worktreeBytes + scratchBytes, worktreeBytes, scratchBytes });

describe('machineLeftoversOf with the disk measure (issue #2504 part 10)', () => {
  it('sums what each leftover entry holds on disk, each part of a job once', () => {
    const leftovers = [
      { jobId: 'j1', endedAt: AT, entries: [entry('j1', 'scratch_dir'), entry('j1', 'container_runtime'), entry('j1', 'job_scope')] },
      { jobId: 'j2', endedAt: AT, entries: [entry('j2', 'job_worktree')] },
      { jobId: 'j3', endedAt: AT, entries: [entry('j3', 'job_worktree'), entry('j3', 'scratch_dir', { state: 'failed' })] },
    ];
    expect(machineLeftoversOf(leftovers, 'm1', [disk('j1', 100, 7), disk('j2', 30, 5), disk('j3', 2, 1), disk('j9', 1000, 1000)]))
      .toEqual({ jobs: 3, entries: 6, failed: 1, bytes: 7 + 30 + 3 });
  });

  it('counts the leftover jobs with disk the measure does not name, and says no bytes when it names none', () => {
    const leftovers = [
      { jobId: 'j1', endedAt: AT, entries: [entry('j1', 'scratch_dir')] },
      { jobId: 'j2', endedAt: AT, entries: [entry('j2', 'job_worktree')] },
      { jobId: 'j3', endedAt: AT, entries: [entry('j3', 'job_processes')] },
    ];
    expect(machineLeftoversOf(leftovers, 'm1', [disk('j1', 0, 9)])).toEqual({ jobs: 3, entries: 3, failed: 0, bytes: 9, unmeasured: 1 });
    expect(machineLeftoversOf(leftovers, 'm1', [])).toEqual({ jobs: 3, entries: 3, failed: 0, unmeasured: 2 });
    expect(machineLeftoversOf(leftovers, 'm1')).toEqual({ jobs: 3, entries: 3, failed: 0 });
  });
});
