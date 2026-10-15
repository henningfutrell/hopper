// The head of a tending queue (issue #796): a pull request on its way to the hopper's merge holds its repository's queue.
// Its job's origin does not matter (issue #805): yolo mode merges a job with no origin too, so that pull request holds it.
// Nothing holds it for good (issue #927): checks that stay pending hold it only for a time after the last push; a pull
// request not seen yet, or whose checks the hopper cannot read, holds nothing.
import { describe, expect, it } from 'vitest';
import { PENDING_HOLD_MS, queueHeads } from '../../src/domain/tending-queue.ts';
import type { Job, PullRequestSeen, Tended } from '../../src/domain/types.ts';
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

const head = (job: Job) => queueHeads(REPO.toLowerCase(), [job], () => undefined, () => true, NOW, () => true)[0];
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the tending queue\'s head (issues #796, #805)', () => {
  it('yolo on: a ready pull request of a job with no origin holds the queue, on its way to the merge', () => {
    expect(head(waiting(false))).toEqual({ pullRequest: PR, why: 'merging' });
  });

  it('yolo off: it holds nothing, whatever its origin', () => {
    for (const origin of [true, false]) {
      expect(queueHeads(REPO.toLowerCase(), [waiting(origin)], () => undefined, () => false, NOW, () => true)).toEqual([]);
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

describe('a merged pull request holds nothing (issues #1162, #1210)', () => {
  /** The tended job and its tend job, `status`, with `source` as the tend job's source state; and any other jobs. */
  function tend(status: Job['status'], source: Record<string, unknown> = {}, others: Job[] = []) {
    const t: Tended = { pullRequest: PR, step: 'rebase', nextJobId: 'job-2' };
    const jobs = [
      jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: { follow: 'tended', pullRequest: PR, tended: t } } }),
      jobForIssue(1, { id: 'job-2', status, rerunOf: 'job-1', sourceState: { source } }),
      ...others,
    ];
    return { jobs, get: (id: string) => jobs.find((j) => j.id === id) };
  }
  const heads = ({ jobs, get }: ReturnType<typeof tend>, reported: boolean) => queueHeads(REPO.toLowerCase(), jobs, get, () => false, NOW, () => reported);

  it('a tend job at work holds the queue, and the head names it', () => {
    expect(heads(tend('running'), false)).toEqual([{ pullRequest: PR, why: 'tending', jobId: 'job-2' }]);
  });

  it('a finished tend job holds it only while its end is still to report', () => {
    expect(heads(tend('finished'), false)).toHaveLength(1);
    expect(heads(tend('finished'), true)).toEqual([]);
  });

  it('a tend job that waits on a person holds nothing', () => {
    for (const status of ['waiting_answer', 'parked', 'operator_led'] as const) expect(heads(tend(status), false)).toEqual([]);
  });

  it('a tend job that waits on its own command holds nothing (issue #1210); on another wait it still holds', () => {
    const own = tend('waiting_on');
    own.jobs[1] = { ...own.jobs[1]!, wait: { for: 'checks', until: 'own command b1 ends', since: ago(60_000), ownCommand: true } };
    expect(heads(own, false)).toEqual([]);
    const outside = tend('waiting_on');
    outside.jobs[1] = { ...outside.jobs[1]!, wait: { for: 'a review', since: ago(60_000) } };
    expect(heads(outside, false)).toEqual([{ pullRequest: PR, why: 'tending', jobId: 'job-2' }]);
  });

  it('a pull request a job saw merged or closed holds nothing, even while its tend job runs', () => {
    for (const follow of ['merged', 'closed']) {
      const other = jobForIssue(1, { id: 'job-0', status: 'finished', sourceState: { source: { follow, pullRequest: PR } } });
      expect(heads(tend('running', {}, [other]), false)).toEqual([]);
    }
  });
});
