// The maids' cleanup items (issue #2504 part 14): which ledger entries are due, by job and machine, the backoff between
// attempts, and the scratch dir the reap is given.
import { describe, expect, it } from 'vitest';
import { MAID_RETRY_FIRST_MS, MAID_RETRY_MAX_MS, maidRetryMs, maidScratchOf, maidWorkOf } from '../../src/domain/maids.ts';
import type { LedgerEntry } from '../../src/domain/resource-ledger.ts';
import type { Job } from '../../src/domain/types.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const entry = (jobId: string, kind: LedgerEntry['kind'], extra: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId, machineId: 'm1', kind, locator: kind === 'scratch_dir' ? `/w/.worktrees/@scratch/${jobId}` : `${kind}-${jobId}`, createdAt: at(-300), state: 'failed', ...extra });

describe('the maids\' backoff (issue #2504 part 14)', () => {
  it('waits a minute after the first attempt, doubles it after each attempt, and waits an hour at most', () => {
    expect(MAID_RETRY_FIRST_MS).toBe(60_000);
    expect([1, 2, 3, 4, 7, 50].map(maidRetryMs)).toEqual([60_000, 120_000, 240_000, 480_000, MAID_RETRY_MAX_MS, MAID_RETRY_MAX_MS]);
    expect(MAID_RETRY_MAX_MS).toBe(3_600_000);
  });
});

describe('the maids\' cleanup items (issue #2504 part 14)', () => {
  const jobs: Record<string, Pick<Job, 'status' | 'cleanupDue' | 'cleanupDeferred'>> = {
    done: { status: 'finished' }, run: { status: 'running' }, due: { status: 'failed', cleanupDue: { at: at(-1) } },
    deferred: { status: 'cancelled', cleanupDeferred: { at: at(-1), error: 'no route' } },
  };
  const jobOf = (id: string) => jobs[id];

  it('takes the open entries of an ended job whose own cleanup is over, by job and machine', () => {
    const scratch = entry('done', 'scratch_dir'), scope = entry('done', 'job_scope', { state: 'live' }), other = entry('done', 'job_processes', { machineId: 'm2' });
    expect(maidWorkOf([scratch, scope, other], jobOf, NOW)).toEqual([
      { jobId: 'done', machineId: 'm1', entries: [scratch, scope] },
      { jobId: 'done', machineId: 'm2', entries: [other] },
    ]);
  });

  it('leaves a job not ended, one whose own cleanup is due or deferred, and a job the store does not know', () => {
    expect(maidWorkOf(['run', 'due', 'deferred', 'stranger'].map((id) => entry(id, 'scratch_dir')), jobOf, NOW)).toEqual([]);
  });

  it('leaves a closed entry, a herdr pane, an entry kept for a retention, and one whose next attempt is not due', () => {
    const open = [
      entry('done', 'scratch_dir', { state: 'kept' }), entry('done', 'job_scope', { state: 'reaped' }), entry('done', 'job_worktree', { state: 'retired' }),
      entry('done', 'herdr_pane'), entry('done', 'container_runtime', { retainedUntil: at(1) }), entry('done', 'job_processes', { attempts: 2, nextAttemptAt: at(1) }),
    ];
    expect(maidWorkOf(open, jobOf, NOW)).toEqual([]);
    const due = [entry('done', 'container_runtime', { retainedUntil: at(0) }), entry('done', 'job_processes', { attempts: 2, nextAttemptAt: at(-1) })];
    expect(maidWorkOf(due, jobOf, NOW)).toEqual([{ jobId: 'done', machineId: 'm1', entries: due }]);
  });

  it('gives the reap the scratch dir its entries on that machine name: the dir, its container runtime, or its job worktree\'s work tree', () => {
    expect(maidScratchOf([entry('j', 'scratch_dir', { state: 'reaped' })], 'j', 'm1')).toBe('/w/.worktrees/@scratch/j');
    expect(maidScratchOf([entry('j', 'container_runtime', { locator: '/v/.worktrees/@scratch/j/containers' })], 'j', 'm1')).toBe('/v/.worktrees/@scratch/j');
    expect(maidScratchOf([entry('j', 'job_worktree', { locator: '/v/.worktrees/app/j' })], 'j', 'm1')).toBe('/v/.worktrees/@scratch/j');
    expect(maidScratchOf([entry('j', 'job_worktree', { locator: '/v/workspace/worktrees/app-j' })], 'j', 'm1')).toBe('/v/.hopper-scratch/j');
    expect(maidScratchOf([entry('j', 'scratch_dir', { machineId: 'm2' }), entry('j', 'job_scope')], 'j', 'm1')).toBeUndefined();
  });
});
