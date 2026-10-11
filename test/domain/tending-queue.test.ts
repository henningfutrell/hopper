// The head of a tending queue (issue #796): a pull request on its way to the hopper's merge holds its repository's queue.
// Its job's origin does not matter (issue #805): yolo mode merges a job with no origin too, so that pull request holds it.
import { describe, expect, it } from 'vitest';
import { queueHead } from '../../src/domain/tending-queue.ts';
import type { Job } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const PR = `https://github.com/${REPO}/pull/7`;
const seen = { draft: false, conflicting: false, checks: 'passing' as const };

function waiting(origin: boolean): Job {
  const job = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: { follow: 'open', pullRequest: PR, seen } } });
  if (origin) return job;
  const { origin: _o, ...source } = job.source!;
  return { ...job, source };
}

describe('the tending queue\'s head (issues #796, #805)', () => {
  it('yolo on: a ready pull request of a job with no origin holds the queue, on its way to the merge', () => {
    const job = waiting(false);
    expect(queueHead(REPO.toLowerCase(), [job], () => undefined, () => true)).toEqual({ pullRequest: PR, why: 'merging' });
  });

  it('yolo off: it holds nothing, whatever its origin', () => {
    for (const origin of [true, false]) {
      expect(queueHead(REPO.toLowerCase(), [waiting(origin)], () => undefined, () => false)).toBeUndefined();
    }
  });
});
