// Kept work (issue #1010): the ended jobs whose scratch dir the reap or the sweep kept because it holds work not pushed,
// read from the work trail. Pure.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { discardReasonOf, keptAgainOf, keptPushedOf, keptWorkOf, proxyPushedOf, pushedBranchOf, scratchOf } from '../../src/domain/kept-work.ts';

let seq = 0;
const ev = (type: 'job.work_kept' | 'job.work_removed' | 'job.continued', jobId: string, paths: string[], at = '2026-10-13T00:00:00.000Z'): DomainEvent =>
  ({ id: `e${++seq}`, seq, type, jobId, at, v: 1, data: { paths } }) as unknown as DomainEvent;

describe('kept work, from the work trail (issue #1010)', () => {
  it('a job whose newest work event kept its work: its paths and when; one removed since is not kept', () => {
    // Newest first, as the event log answers.
    const trail = [
      ev('job.work_removed', 'b', ['/w/.worktrees/@scratch/b']),
      ev('job.work_kept', 'a', ['/w/.worktrees/@scratch/a/repo'], '2026-10-13T02:00:00.000Z'),
      ev('job.work_kept', 'b', ['/w/.worktrees/@scratch/b/repo']),
      ev('job.work_kept', 'a', ['/w/.worktrees/@scratch/a/old'], '2026-10-13T01:00:00.000Z'),
    ];
    expect(keptWorkOf(trail)).toEqual([{ jobId: 'a', paths: ['/w/.worktrees/@scratch/a/repo'], at: '2026-10-13T02:00:00.000Z' }]);
  });

  it('the scratch dir of a job\'s kept repositories: the job\'s own, never a path outside it', () => {
    expect(scratchOf(['/w/.worktrees/@scratch/a/repo', '/w/.worktrees/@scratch/a/x/y'], 'a')).toBe('/w/.worktrees/@scratch/a');
    expect(scratchOf(['/w/.worktrees/@scratch/a'], 'a')).toBe('/w/.worktrees/@scratch/a');
    expect(scratchOf(['/w/.worktrees/@scratch/b/repo'], 'a')).toBeUndefined();
    expect(scratchOf(['/w/a/repo'], 'a')).toBeUndefined();
    // A job worktree in the work tree's .worktrees (issue #1188): the scratch dir beside it in that work tree.
    expect(scratchOf(['/w/.worktrees/my-app/a'], 'a')).toBe('/w/.worktrees/@scratch/a');
    expect(scratchOf(['/w/.worktrees/my-app/ba'], 'a')).toBeUndefined();
    // Kept work of the layout before: its own scratch dir, or the new one beside its worktree; the reap takes both.
    expect(scratchOf(['/w/.hopper-scratch/a/repo'], 'a')).toBe('/w/.hopper-scratch/a');
    expect(scratchOf(['/w/workspace/worktrees/my-app-a'], 'a')).toBe('/w/.worktrees/@scratch/a');
    expect(scratchOf(['/w/workspace/worktrees/my-app-ba'], 'a')).toBeUndefined();
  });
});

describe('why nobody waits on kept work (issue #1187)', () => {
  const job = (id: string, status: Job['status'], extra: Partial<Job> = {}, spec: Partial<Job['spec']> = {}): Job =>
    ({ id, spec: { executor: 'x', payload: {}, ...spec }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1, ...extra }) as Job;
  const old = job('old', 'failed');
  const none = new Set<string>();

  it('its item done: merged, before anything else', () => {
    expect(discardReasonOf(old, true, job('new', 'running'), none)).toBe('merged');
  });

  it('the newest job of its item finished, its cleanup done, with no work kept: superseded', () => {
    expect(discardReasonOf(old, false, job('new', 'finished'), none)).toBe('superseded');
    expect(discardReasonOf(old, false, old, none)).toBeUndefined();
    expect(discardReasonOf(old, false, undefined, none)).toBeUndefined();
    for (const status of ['running', 'failed', 'cancelled', 'queued'] as const) expect(discardReasonOf(old, false, job('new', status), none)).toBeUndefined();
    expect(discardReasonOf(old, false, job('new', 'finished'), new Set(['new']))).toBeUndefined();
    expect(discardReasonOf(old, false, job('new', 'finished', { cleanupDeferred: { at: '', error: 'x' } }), none)).toBeUndefined();
  });

  it('a finished proposal or research job: it never had work to push; a failed one waits on a person', () => {
    expect(discardReasonOf(job('p', 'finished', {}, { proposal: true }), false, undefined, none)).toBe('proposal');
    expect(discardReasonOf(job('r', 'finished', {}, { research: true }), false, undefined, none)).toBe('research');
    expect(discardReasonOf(job('p', 'failed', {}, { proposal: true }), false, undefined, none)).toBeUndefined();
    expect(discardReasonOf(job('w', 'finished'), false, undefined, none)).toBeUndefined();
  });
});

describe('kept again: the job went on in its work tree and the same work is kept (issue #1470)', () => {
  const kept = (paths: string[]) => ev('job.work_kept', 'a', paths);
  const on = ev('job.continued', 'a', []);
  const removed = ev('job.work_removed', 'a', []);
  const other = '/w/.worktrees/@scratch/a/other-repo';
  const own = '/w/.worktrees/my-app/a';

  it('kept, went on, kept the same or less: kept again', () => {
    // Newest first, as the event log answers.
    expect(keptAgainOf([kept([other]), on, kept([other])])).toBe(true);
    expect(keptAgainOf([kept([other]), on, kept([own, other])])).toBe(true);
    // Twice over: the newest go-on counts.
    expect(keptAgainOf([kept([other]), on, kept([other]), on, kept([own, other])])).toBe(true);
  });

  it('never went on, kept new work since, or nothing kept now: not kept again', () => {
    expect(keptAgainOf([kept([other])])).toBe(false);
    expect(keptAgainOf([kept([own, other]), on, kept([other])])).toBe(false);
    expect(keptAgainOf([removed, on, kept([other])])).toBe(false);
    expect(keptAgainOf([on, kept([other])])).toBe(false);
    // Went on with nothing kept before it: its work is new.
    expect(keptAgainOf([kept([other]), on, removed, kept([other])])).toBe(false);
    expect(keptAgainOf([])).toBe(false);
  });
});

describe('kept work the hopper pushed itself (issue #2087)', () => {
  const push = (type: 'github_proxy.done' | 'gitlab_proxy.done', data: Record<string, unknown>): DomainEvent =>
    ({ id: `e${++seq}`, seq, type, jobId: 'a', at: '', v: 1, data: { requestId: 'r', op: 'git.push', refs: ['refs/heads/x'], ...data } }) as unknown as DomainEvent;

  it('the commits of its git pushes through the hopper, on GitHub and GitLab; a push recorded before it named none', () => {
    const trail = [push('github_proxy.done', { repo: 'o/r', heads: ['c1', 'c2'] }), push('gitlab_proxy.done', { project: 'o/r', heads: ['c3'] }), push('github_proxy.done', { repo: 'o/r' })];
    expect([...proxyPushedOf(trail)].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(proxyPushedOf([{ ...push('github_proxy.done', { repo: 'o/r' }), data: { op: 'pr.create', heads: ['c4'] } } as unknown as DomainEvent])).toEqual(new Set());
  });

  it('the branch a push moved to a commit (issue #2459): the job\'s own branch first, else the newest push', () => {
    const trail = [
      push('github_proxy.done', { repo: 'o/r', refs: ['refs/heads/b', 'refs/heads/x'], heads: ['c2', 'c1'] }),
      push('github_proxy.done', { repo: 'o/r', refs: ['refs/heads/a'], heads: ['c1'] }),
    ];
    expect(pushedBranchOf(trail, 'c1')).toBe('x');
    expect(pushedBranchOf(trail, 'c1', 'a')).toBe('a');
    expect(pushedBranchOf(trail, 'c2', 'a')).toBe('b');
    expect(pushedBranchOf(trail, 'c3')).toBeUndefined();
    expect(pushedBranchOf([push('github_proxy.done', { repo: 'o/r' })], 'c1')).toBeUndefined();
  });

  it('a kept repository whose every tip the hopper pushed; one with a tip it did not, or with no tip (a change, an older client), is not', () => {
    const pushed = new Set(['c1', 'c2']);
    const reaped = { kept: ['/s/a', '/s/b', '/s/c', '/s/d'], tips: { '/s/a': ['c1'], '/s/b': ['c1', 'c2'], '/s/c': ['c1', 'c9'], '/s/d': [] } };
    expect(keptPushedOf(reaped, pushed)).toEqual(['/s/a', '/s/b']);
    expect(keptPushedOf({ kept: ['/s/a'] }, pushed)).toEqual([]);
  });
});
