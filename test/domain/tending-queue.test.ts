// The head of a tending queue (issue #796): a pull request on its way to the hopper's merge holds its repository's queue.
// Its job's origin does not matter (issue #805): yolo mode merges a job with no origin too, so that pull request holds it.
// Nothing holds it for good (issue #927): checks that stay pending hold it only for a time after the last push; a pull
// request not seen yet, or whose checks the hopper cannot read, holds nothing.
import { describe, expect, it } from 'vitest';
import { PENDING_HOLD_MS, queueHead } from '../../src/domain/tending-queue.ts';
import type { Job, PullRequestSeen } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const PR = `https://github.com/${REPO}/pull/7`;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const seen: PullRequestSeen = { draft: false, conflicting: false, checks: 'passing' };

function waiting(origin: boolean, s: PullRequestSeen | null = seen): Job {
  const job = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: { follow: 'open', pullRequest: PR, ...(s ? { seen: s } : {}) } } });
  if (origin) return job;
  const { origin: _o, ...source } = job.source!;
  return { ...job, source };
}

const head = (job: Job) => queueHead(REPO.toLowerCase(), [job], () => undefined, () => true, NOW);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the tending queue\'s head (issues #796, #805)', () => {
  it('yolo on: a ready pull request of a job with no origin holds the queue, on its way to the merge', () => {
    expect(head(waiting(false))).toEqual({ pullRequest: PR, why: 'merging' });
  });

  it('yolo off: it holds nothing, whatever its origin', () => {
    for (const origin of [true, false]) {
      expect(queueHead(REPO.toLowerCase(), [waiting(origin)], () => undefined, () => false, NOW)).toBeUndefined();
    }
  });
});

describe('nothing holds the tending queue for good (issue #927)', () => {
  it('checks pending since a recent push: it holds the queue', () => {
    expect(head(waiting(true, { ...seen, checks: 'pending', pushedAt: ago(PENDING_HOLD_MS - 60_000) }))).toEqual({ pullRequest: PR, why: 'merging' });
  });

  it('checks pending for longer than the hold after the last push, or with no push time: it holds nothing', () => {
    expect(head(waiting(true, { ...seen, checks: 'pending', pushedAt: ago(PENDING_HOLD_MS) }))).toBeUndefined();
    expect(head(waiting(true, { ...seen, checks: 'pending' }))).toBeUndefined();
  });

  it('not seen yet, or checks the hopper cannot read: it holds nothing', () => {
    expect(head(waiting(true, null))).toBeUndefined();
    expect(head(waiting(true, { ...seen, checks: 'unknown' }))).toBeUndefined();
  });

  it('no checks: it holds the queue until the merge', () => {
    expect(head(waiting(true, { ...seen, checks: 'none', pushedAt: ago(PENDING_HOLD_MS * 2) }))).toEqual({ pullRequest: PR, why: 'merging' });
  });
});
