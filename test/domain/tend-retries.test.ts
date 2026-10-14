// A tend run again (issues #1010, #1143 part 3) keeps `tended` on the job it tended, not on the tend job before it: the
// tend of a job is found up its whole chain of runs again (`tendOf`), so a failed retry is a failed tend, and a retry at
// work heads its tending queue. A failed rebase is due again once its base branch moved (`baseMoved`), at most
// MAX_TEND_RETRIES in a row.
import { describe, expect, it } from 'vitest';
import { queueHeads } from '../../src/domain/tending-queue.ts';
import { failedTend, MAX_TEND_RETRIES, tendOf, tendRetryAt, type Job, type Tended } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const PR = `https://github.com/${REPO}/pull/7`;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');

/** The tended job, its first tend job (failed), and that one's retry, `status`. */
function chain(status: Job['status'], tended: Partial<Tended> = {}) {
  const t: Tended = { pullRequest: PR, step: 'rebase', nextJobId: 'job-3', retries: 1, ...tended };
  const jobs = [
    jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: { follow: 'tended', pullRequest: PR, tended: t } } }),
    jobForIssue(1, { id: 'job-2', status: 'failed', rerunOf: 'job-1' }),
    jobForIssue(1, { id: 'job-3', status, rerunOf: 'job-2' }),
  ];
  const get = (id: string) => jobs.find((j) => j.id === id);
  return { t, jobs, get, retry: jobs[2]! };
}

describe('the tend of a job, up its chain of runs again (issue #1143 part 3)', () => {
  it('a retry\'s tend is on the job it tended; a failed retry is a failed tend', () => {
    const { t, get, retry } = chain('failed');
    expect(tendOf(retry, get)).toEqual(t);
    expect(failedTend(retry, get)).toBe(true);
    expect(failedTend(get('job-2')!, get)).toBe(false);
  });

  it('a retry at work heads its tending queue', () => {
    const { jobs, get } = chain('running');
    expect(queueHeads(REPO.toLowerCase(), jobs, get, () => true, NOW, () => false)).toEqual([{ pullRequest: PR, why: 'tending', job: { id: 'job-3', status: 'running' } }]);
  });
});

describe('a failed rebase, once its base branch moved (issue #1143 part 3)', () => {
  const moved = new Date(NOW).toISOString();

  it('is due from when the move was seen; before that, never', () => {
    const { t, retry } = chain('failed', { baseAt: 'a'.repeat(40) });
    expect(tendRetryAt(t, retry)).toBeUndefined();
    expect(tendRetryAt({ ...t, baseMoved: moved }, retry)).toBe(NOW);
  });

  it(`not after ${MAX_TEND_RETRIES} in a row, not for fix_checks, not for a rejected tend job`, () => {
    const { t, retry } = chain('failed', { baseMoved: moved });
    expect(tendRetryAt({ ...t, retries: MAX_TEND_RETRIES }, retry)).toBeUndefined();
    expect(tendRetryAt({ ...t, step: 'fix_checks' }, retry)).toBeUndefined();
    expect(tendRetryAt(t, { ...retry, status: 'rejected' })).toBeUndefined();
  });
});
