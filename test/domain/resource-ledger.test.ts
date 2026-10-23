// Issue #2504: a job's resource ledger — what the hopper made for a job on a machine, from its executor's saved state, closed
// as each reap says — and the job's cleanup status read from it. Pure.
import { describe, expect, it } from 'vitest';
import { CLEANUP_GRACE_MINUTES, cleanupLeftoversOf, cleanupStatusOf, goneClosures, ledgerEntriesOf, ledgerParts, machineLeftoversOf, reapClosures, retainedEntriesOf, unledgeredEntriesOf, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-22T10:00:00.000Z';
const SCRATCH = '/w/.worktrees/@scratch/j1';
const TREE = '/w/.worktrees/app/j1';
const RUNTIME = `${SCRATCH}/containers`;

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

  it('names the job\'s own container runtime, its dir in the scratch dir (issue #2504 part 4)', () => {
    expect(ledgerEntriesOf('j1', 'm1', { cwd: '/w', containerRuntime: RUNTIME }, AT)).toEqual([
      { jobId: 'j1', machineId: 'm1', kind: 'scratch_dir', locator: SCRATCH, createdAt: AT },
      { jobId: 'j1', machineId: 'm1', kind: 'container_runtime', locator: RUNTIME, createdAt: AT },
    ]);
    expect(ledgerEntriesOf('j1', 'm1', { cwd: '/w', containerRuntime: 'containers' }, AT).map((e) => e.kind)).toEqual(['scratch_dir']);
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

  it('reaps the container runtime with kept work, as the reap resets it, and fails it while its storage stays (part 4)', () => {
    const runtime = entry('container_runtime', RUNTIME);
    expect(reapClosures([runtime], { kept: [SCRATCH] }).map((c) => c.state)).toEqual(['reaped']);
    expect(reapClosures([runtime], { kept: [], left: [`${RUNTIME}/storage`] })).toMatchObject([{ state: 'failed', reason: `${RUNTIME}/storage is still there` }]);
    expect(reapClosures([runtime], { kept: [] }, false)).toEqual([]);
  });

  it('closes kept work a later reap removed, and never judges a reaped entry again', () => {
    const closed = reapClosures([entry('scratch_dir', SCRATCH, { state: 'kept' }), entry('job_worktree', TREE, { state: 'reaped' })], { kept: [] });
    expect(closed.map((c) => [c.entry.kind, c.state])).toEqual([['scratch_dir', 'reaped']]);
    expect(reapClosures([entry('scratch_dir', SCRATCH, { state: 'kept' })], { kept: [SCRATCH] })).toEqual([]);
  });

  it('reaps a failed entry a later reap removed, and keeps it failed while the same dir stays', () => {
    const failed = entry('scratch_dir', SCRATCH, { state: 'failed', reason: `${SCRATCH} is still there` });
    expect(reapClosures([failed], { kept: [] }).map((c) => c.state)).toEqual(['reaped']);
    expect(reapClosures([failed], { kept: [], left: [SCRATCH] })).toEqual([]);
    expect(reapClosures([failed], { kept: [], left: [`${SCRATCH}/containers`] })).toMatchObject([{ state: 'failed', reason: `${SCRATCH}/containers is still there` }]);
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

  it('says retained while every live entry is kept for its retention (part 5)', () => {
    const kept = entry('scratch_dir', SCRATCH, { retainedUntil: AT });
    expect(cleanupStatusOf(ended, [kept, entry('job_scope', 's', { state: 'reaped' })])).toBe('retained');
    expect(cleanupStatusOf(ended, [kept, entry('job_worktree', TREE)])).toBe('pending');
    expect(cleanupStatusOf(ended, [kept, entry('job_worktree', TREE, { state: 'failed', reason: 'x' })])).toBe('failed');
    const parts = ledgerParts(ended, [kept]);
    expect(parts[0]).toMatchObject({ id: 'cleanup', status: 'open', label: 'Cleanup: work kept for its retention' });
    expect(parts[1]?.detail).toBe(`${SCRATCH}: still there, kept until ${AT}`);
  });
});

describe('retainedEntriesOf (issue #2504 part 5)', () => {
  it('names each entry the retention keeps: not the scope, not one closed reaped or kept', () => {
    const all = [entry('scratch_dir', SCRATCH), entry('job_worktree', TREE, { state: 'failed', reason: 'x' }), entry('container_runtime', RUNTIME),
      entry('job_scope', 's'), entry('job_worktree', '/w/.worktrees/b/j1', { state: 'kept' }), entry('scratch_dir', '/v/.worktrees/@scratch/j1', { state: 'reaped' })];
    expect(retainedEntriesOf(all).map((e) => e.locator)).toEqual([SCRATCH, TREE, RUNTIME]);
  });
});

describe('cleanupLeftoversOf (issue #2504)', () => {
  const NOW = Date.parse(AT);
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const jobs: Record<string, { status: 'finished' | 'failed' | 'running'; finishedAt?: string; updatedAt: string }> = {
    j1: { status: 'finished', finishedAt: ago(CLEANUP_GRACE_MINUTES + 1), updatedAt: ago(1) },
    j2: { status: 'failed', updatedAt: ago(CLEANUP_GRACE_MINUTES) },
    soon: { status: 'finished', finishedAt: ago(CLEANUP_GRACE_MINUTES - 1), updatedAt: ago(1) },
    live: { status: 'running', updatedAt: ago(600) },
  };
  const of = (jobId: string, state: LedgerEntry['state'] = 'live') => entry('scratch_dir', `/w/.worktrees/@scratch/${jobId}`, { jobId, state });

  it('names each ended job past the grace period with its entries still live or failed', () => {
    const open = [of('j1'), entry('job_scope', 's', { jobId: 'j1', state: 'failed', reason: 'x' }), of('j2', 'failed'), of('soon'), of('live'), of('gone')];
    expect(cleanupLeftoversOf(open, (id) => jobs[id], NOW)).toEqual([
      { jobId: 'j1', endedAt: jobs.j1!.finishedAt, entries: [open[0], open[1]] },
      { jobId: 'j2', endedAt: jobs.j2!.updatedAt, entries: [open[2]] },
    ]);
  });

  it('never names a reaped or kept entry', () => {
    expect(cleanupLeftoversOf([of('j1', 'reaped'), of('j1', 'kept')], (id) => jobs[id], NOW)).toEqual([]);
  });

  it('names an entry kept for a retention only once the grace period after the retention passed (part 5)', () => {
    const until = (min: number) => ({ ...of('j1'), retainedUntil: ago(min) });
    expect(cleanupLeftoversOf([until(-600)], (id) => jobs[id], NOW)).toEqual([]);
    expect(cleanupLeftoversOf([until(CLEANUP_GRACE_MINUTES - 1)], (id) => jobs[id], NOW)).toEqual([]);
    const over = until(CLEANUP_GRACE_MINUTES);
    expect(cleanupLeftoversOf([over], (id) => jobs[id], NOW)).toEqual([{ jobId: 'j1', endedAt: jobs.j1!.finishedAt, entries: [over] }]);
    const scope = entry('job_scope', 's', { jobId: 'j1', state: 'failed', reason: 'x' });
    expect(cleanupLeftoversOf([until(-600), scope], (id) => jobs[id], NOW)).toEqual([{ jobId: 'j1', endedAt: jobs.j1!.finishedAt, entries: [scope] }]);
  });
});

describe('goneClosures (issue #2504 part 3)', () => {
  const ended = (id: string) => (id === 'live' ? { status: 'running' as const } : id === 'j1' || id === 'j2' ? { status: 'finished' as const } : undefined);
  const found = { scopes: [], processes: [], scratch: [], trees: [], roots: ['/w'] };
  const all = [entry('scratch_dir', SCRATCH), entry('job_worktree', TREE), entry('job_scope', 'hopper-job-j1.scope', { state: 'failed', reason: 'x' })];

  it("reaps an ended job's entries on this machine that the survey no longer found", () => {
    expect(goneClosures(all, found, 'm1', ended).map((c) => [c.entry.kind, c.state, c.reason])).toEqual([
      ['scratch_dir', 'reaped', 'not found on the machine'], ['job_worktree', 'reaped', 'not found on the machine'], ['job_scope', 'reaped', 'not found on the machine'],
    ]);
  });

  it('reaps the container runtime with its scratch dir gone, and keeps it while the scratch dir is there (part 4)', () => {
    const runtime = [entry('container_runtime', RUNTIME)];
    expect(goneClosures(runtime, found, 'm1', ended).map((c) => [c.entry.kind, c.reason])).toEqual([['container_runtime', 'not found on the machine']]);
    expect(goneClosures(runtime, { ...found, scratch: [{ jobId: 'j1', path: SCRATCH, ageMs: 1 }] }, 'm1', ended)).toEqual([]);
    expect(goneClosures(runtime, { ...found, roots: [] }, 'm1', ended)).toEqual([]);
  });

  it('keeps an entry the survey still found', () => {
    const there = { ...found, scopes: ['j1'], scratch: [{ jobId: 'j1', path: SCRATCH, ageMs: 1 }], trees: [{ path: TREE, ageMs: 1 }] };
    expect(goneClosures(all, there, 'm1', ended)).toEqual([]);
  });

  it('judges a dir only in a work tree the survey looked in, and a job worktree only when the survey lists them', () => {
    expect(goneClosures(all.slice(0, 2), { ...found, roots: ['/v'] }, 'm1', ended)).toEqual([]);
    const { trees: _trees, ...noTrees } = found;
    expect(goneClosures(all.slice(0, 2), noTrees, 'm1', ended).map((c) => c.entry.kind)).toEqual(['scratch_dir']);
  });

  it("never judges a job that has not ended, a job the store does not know, or another machine's entry", () => {
    const of = (jobId: string, machineId = 'm1') => entry('scratch_dir', `/w/.worktrees/@scratch/${jobId}`, { jobId, machineId });
    expect(goneClosures([of('live'), of('unknown'), of('j2', 'm2')], found, 'm1', ended)).toEqual([]);
  });
});

describe('machineLeftoversOf (issue #2504 part 3)', () => {
  it('counts the leftover jobs and entries on one machine', () => {
    const leftovers = [
      { jobId: 'j1', endedAt: AT, entries: [entry('scratch_dir', SCRATCH), entry('job_scope', 's', { machineId: 'm2' })] },
      { jobId: 'j2', endedAt: AT, entries: [entry('scratch_dir', 'x', { jobId: 'j2' }), entry('job_worktree', 'y', { jobId: 'j2', state: 'failed' })] },
    ];
    expect(machineLeftoversOf(leftovers, 'm1')).toEqual({ jobs: 2, entries: 3, failed: 1 });
    expect(machineLeftoversOf(leftovers, 'm2')).toEqual({ jobs: 1, entries: 1, failed: 0 });
    expect(machineLeftoversOf(leftovers, 'm3')).toBeUndefined();
  });
});

describe('unledgeredEntriesOf (issue #2504 part 6)', () => {
  const HOUR = 3600_000, NOW = Date.parse(AT);
  const jobs: Record<string, { id: string; status: 'finished' | 'running'; finishedAt?: string }> = {
    j1: { id: 'j1', status: 'finished', finishedAt: '2026-10-20T10:00:00.000Z' }, live: { id: 'live', status: 'running' },
  };
  const found = {
    scopes: ['j1', 'live'], processes: [], roots: ['/w'],
    scratch: [{ jobId: 'j1', path: SCRATCH, ageMs: 2 * HOUR }, { jobId: 'live', path: '/w/.worktrees/@scratch/live', ageMs: 1 }, { jobId: 'other', path: '/w/.worktrees/@scratch/other', ageMs: 1 }],
    trees: [{ path: TREE, ageMs: 30 * HOUR }, { path: '/w/workspace/worktrees/my-app-j1', ageMs: 30 * HOUR }, { path: '/w/.worktrees/app/other', ageMs: 1 }],
  };
  const of = (ledgered: string[] = []) => unledgeredEntriesOf(found, new Set(ledgered), (id) => jobs[id] as never, 'm1', undefined, NOW);

  it("records what the survey found of an ended job that its ledger does not name, kept until the sweep's reap of it", () => {
    expect(of()).toEqual([
      { jobId: 'j1', machineId: 'm1', kind: 'scratch_dir', locator: SCRATCH, createdAt: AT, retainedUntil: new Date(NOW + 22 * HOUR).toISOString() },
      { jobId: 'j1', machineId: 'm1', kind: 'job_worktree', locator: TREE, createdAt: AT, retainedUntil: new Date(NOW - 6 * HOUR).toISOString() },
      { jobId: 'j1', machineId: 'm1', kind: 'job_worktree', locator: '/w/workspace/worktrees/my-app-j1', createdAt: AT, retainedUntil: new Date(NOW - 6 * HOUR).toISOString() },
      { jobId: 'j1', machineId: 'm1', kind: 'job_scope', locator: 'hopper-job-j1.scope', createdAt: AT },
    ]);
  });

  it('records nothing the ledger names already, nothing of a job not ended, and nothing of a job the store does not know', () => {
    const keys = [`j1\0scratch_dir\0${SCRATCH}`, `j1\0job_worktree\0${TREE}`, 'j1\0job_worktree\0/w/workspace/worktrees/my-app-j1', 'j1\0job_scope\0hopper-job-j1.scope'];
    expect(of(keys)).toEqual([]);
  });
});
