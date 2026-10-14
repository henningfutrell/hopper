// A stray pull request (issue #1143 part 4): an open pull request a job named, that no job follows, of an item no job works
// on. The newest job that names it holds it. A followed one, one of an item a job is at work on, one merged, closed or
// abandoned, and one a proposal's follow-ons took are no strays.
import { describe, expect, it } from 'vitest';
import { strayPullRequests, type Job } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const PR = `https://github.com/${REPO}/pull/7`;
const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 12, m)).toISOString();
const naming = (id: string, n: number, m: number, status: Job['status'], source: Record<string, unknown>, pr = PR): Job =>
  jobForIssue(n, { id, status, createdAt: at(m), sourceState: { source: { pullRequest: pr, ...source } } });

describe('stray pull requests (issue #1143 part 4)', () => {
  it('a tended job whose tend failed: its pull request is a stray, held by that job', () => {
    const jobs = [
      naming('job-1', 1, 0, 'finished', { follow: 'tended', part: true }),
      jobForIssue(1, { id: 'job-2', status: 'failed', createdAt: at(1), rerunOf: 'job-1' }),
    ];
    expect(strayPullRequests(jobs)).toEqual([{ jobId: 'job-1', pullRequest: PR, part: true }]);
  });

  it('a cancelled job that named one, with no follow: a stray', () => {
    expect(strayPullRequests([naming('job-1', 1, 0, 'cancelled', {})])).toEqual([{ jobId: 'job-1', pullRequest: PR, part: false }]);
  });

  it('two jobs name the same one: the newer holds it', () => {
    const jobs = [naming('job-1', 1, 0, 'finished', { follow: 'tended' }), naming('job-2', 1, 1, 'failed', { follow: 'reworked' })];
    expect(strayPullRequests(jobs)).toEqual([{ jobId: 'job-2', pullRequest: PR, part: false }]);
  });

  it('followed by a job: no stray', () => {
    const jobs = [naming('job-1', 1, 0, 'finished', { follow: 'tended' }), naming('job-2', 1, 1, 'finished', { follow: 'open' })];
    expect(strayPullRequests(jobs)).toEqual([]);
  });

  it('a job of its item is at work: no stray', () => {
    const jobs = [naming('job-1', 1, 0, 'finished', { follow: 'tended' }), jobForIssue(1, { id: 'job-2', status: 'running', createdAt: at(1) })];
    expect(strayPullRequests(jobs)).toEqual([]);
  });

  it('merged, closed or abandoned: no stray', () => {
    const jobs = (['merged', 'closed', 'abandoned'] as const).map((follow, i) =>
      naming(`job-${i}`, i + 1, i, 'finished', { follow }, `https://github.com/${REPO}/pull/${i + 10}`));
    expect(strayPullRequests(jobs)).toEqual([]);
  });

  it('a proposal\'s job whose follow-ons go on with its work: no stray', () => {
    const job = { ...naming('job-1', 1, 0, 'finished', {}), result: { proposal: { followOns: ['job-2'] } } } as Job;
    expect(strayPullRequests([job])).toEqual([]);
  });

  it('each item on its own: a job at work on another item changes nothing', () => {
    const jobs = [naming('job-1', 1, 0, 'failed', { follow: 'tended' }), jobForIssue(2, { id: 'job-2', status: 'running', createdAt: at(1) })];
    expect(strayPullRequests(jobs)).toEqual([{ jobId: 'job-1', pullRequest: PR, part: false }]);
  });
});
