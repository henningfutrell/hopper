// Kept work (issue #1010): the ended jobs whose scratch dir the reap or the sweep kept because it holds work not pushed,
// read from the work trail. Pure.
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { keptWorkOf, scratchOf } from '../../src/domain/kept-work.ts';

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
  });
});
