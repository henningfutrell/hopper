// Kept work (issue #1010): the ended jobs whose scratch dir the reap or the sweep kept because it holds work not pushed,
// read from the work trail. Pure.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { discardReasonOf, keptWorkOf, scratchOf } from '../../src/domain/kept-work.ts';

let seq = 0;
const ev = (type: 'job.work_kept' | 'job.work_removed', jobId: string, paths: string[], at = '2026-10-13T00:00:00.000Z'): DomainEvent =>
  ({ id: `e${++seq}`, seq, type, jobId, at, v: 1, data: { paths } }) as unknown as DomainEvent;

describe('kept work, from the work trail (issue #1010)', () => {
  it('a job whose newest work event kept its work: its paths and when; one removed since is not kept', () => {
    // Newest first, as the event log answers.
    const trail = [
      ev('job.work_removed', 'b', ['/w/.hopper-scratch/b']),
      ev('job.work_kept', 'a', ['/w/.hopper-scratch/a/repo'], '2026-10-13T02:00:00.000Z'),
      ev('job.work_kept', 'b', ['/w/.hopper-scratch/b/repo']),
      ev('job.work_kept', 'a', ['/w/.hopper-scratch/a/old'], '2026-10-13T01:00:00.000Z'),
    ];
    expect(keptWorkOf(trail)).toEqual([{ jobId: 'a', paths: ['/w/.hopper-scratch/a/repo'], at: '2026-10-13T02:00:00.000Z' }]);
  });

  it('the scratch dir of a job\'s kept repositories: the job\'s own, never a path outside it', () => {
    expect(scratchOf(['/w/.hopper-scratch/a/repo', '/w/.hopper-scratch/a/x/y'], 'a')).toBe('/w/.hopper-scratch/a');
    expect(scratchOf(['/w/.hopper-scratch/a'], 'a')).toBe('/w/.hopper-scratch/a');
    expect(scratchOf(['/w/.hopper-scratch/b/repo'], 'a')).toBeUndefined();
    expect(scratchOf(['/w/a/repo'], 'a')).toBeUndefined();
    // A job worktree in the work tree's workspace (issue #1103): the scratch dir beside it in that work tree.
    expect(scratchOf(['/w/workspace/worktrees/my-app-a'], 'a')).toBe('/w/.hopper-scratch/a');
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
