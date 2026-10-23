// Issue #2504: a job's resource ledger — what the hopper made for a job on a machine, from its executor's saved state, closed
// as each reap says — and the job's cleanup status read from it. Pure.
import { describe, expect, it } from 'vitest';
import { cleanupStatusOf, ledgerEntriesOf, reapClosures, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-22T10:00:00.000Z';
const SCRATCH = '/w/.worktrees/@scratch/j1';
const TREE = '/w/.worktrees/app/j1';

const entry = (kind: LedgerEntry['kind'], locator: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId: 'j1', machineId: 'm1', kind, locator, createdAt: AT, state: 'live', ...over });

describe('ledgerEntriesOf', () => {
  it('names the scratch dir of the work tree, the job worktree and the job scope', () => {
    expect(ledgerEntriesOf('j1', 'm1', { cwd: '/w', jobWorktree: TREE, scope: 'hopper-job-j1.scope', paneId: 'p' }, AT)).toEqual([
      { jobId: 'j1', machineId: 'm1', kind: 'scratch_dir', locator: SCRATCH, createdAt: AT },
      { jobId: 'j1', machineId: 'm1', kind: 'job_worktree', locator: TREE, createdAt: AT },
      { jobId: 'j1', machineId: 'm1', kind: 'job_scope', locator: 'hopper-job-j1.scope', createdAt: AT },
    ]);
  });

  it('names nothing for a state with no absolute work tree', () => {
    expect(ledgerEntriesOf('j1', 'm1', undefined, AT)).toEqual([]);
    expect(ledgerEntriesOf('j1', 'm1', { cwd: 'relative', jobWorktree: 3 }, AT)).toEqual([]);
  });
});

describe('reapClosures', () => {
  const all = [entry('scratch_dir', SCRATCH), entry('job_worktree', TREE), entry('job_scope', 'hopper-job-j1.scope')];

  it('reaps every entry when the reap kept nothing and left nothing', () => {
    expect(reapClosures(all, { kept: [] }).map((c) => [c.entry.kind, c.state])).toEqual([['scratch_dir', 'reaped'], ['job_worktree', 'reaped'], ['job_scope', 'reaped']]);
  });

  it('keeps the scratch dir and the job worktree together when work is kept', () => {
    expect(reapClosures(all, { kept: [TREE] }).map((c) => [c.entry.kind, c.state])).toEqual([['scratch_dir', 'kept'], ['job_worktree', 'kept'], ['job_scope', 'reaped']]);
  });

  it('fails an entry the reap could not remove, with why', () => {
    const closed = reapClosures(all, { kept: [], left: [`${SCRATCH}/containers`] });
    expect(closed.find((c) => c.entry.kind === 'scratch_dir')).toMatchObject({ state: 'failed', reason: `${SCRATCH}/containers is still there` });
    expect(closed.find((c) => c.entry.kind === 'job_worktree')?.state).toBe('reaped');
  });

  it('closes kept work a later reap removed, and never judges a reaped or failed entry again', () => {
    const closed = reapClosures([entry('scratch_dir', SCRATCH, { state: 'kept' }), entry('job_worktree', TREE, { state: 'reaped' }), entry('job_scope', 's', { state: 'failed' })], { kept: [] });
    expect(closed.map((c) => [c.entry.kind, c.state])).toEqual([['scratch_dir', 'reaped']]);
    expect(reapClosures([entry('scratch_dir', SCRATCH, { state: 'kept' })], { kept: [SCRATCH] })).toEqual([]);
  });
});

describe('cleanupStatusOf', () => {
  const ended = { status: 'finished' as const };
  it('says none with no entry, and in use while the job has not ended', () => {
    expect(cleanupStatusOf(ended, [])).toBe('none');
    expect(cleanupStatusOf({ status: 'running' }, [entry('scratch_dir', SCRATCH)])).toBe('in_use');
  });

  it('follows the cleanup record while it is owed', () => {
    expect(cleanupStatusOf({ ...ended, cleanupDue: { at: AT } }, [entry('scratch_dir', SCRATCH)])).toBe('in_progress');
    expect(cleanupStatusOf({ ...ended, cleanupDeferred: { at: AT, error: 'out of reach' } }, [entry('scratch_dir', SCRATCH)])).toBe('pending');
  });

  it('says pending, failed, kept work or done from the entries once the cleanup ran', () => {
    expect(cleanupStatusOf(ended, [entry('scratch_dir', SCRATCH)])).toBe('pending');
    expect(cleanupStatusOf(ended, [entry('scratch_dir', SCRATCH, { state: 'failed', reason: 'x' }), entry('job_scope', 's', { state: 'reaped' })])).toBe('failed');
    expect(cleanupStatusOf(ended, [entry('scratch_dir', SCRATCH, { state: 'kept' }), entry('job_scope', 's', { state: 'reaped' })])).toBe('kept_work');
    expect(cleanupStatusOf(ended, [entry('scratch_dir', SCRATCH, { state: 'reaped' })])).toBe('done');
  });
});
