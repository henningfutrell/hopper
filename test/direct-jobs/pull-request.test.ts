// Issue #1068: the `direct` source follows a direct job's pull request. Its job opened it through the hopper's GitHub
// proxy (`github_proxy.done`, op `pr.create`): the job's done report keeps it to follow, and the follow, the merge gate,
// the tend note and the check logs are the user's GitHub connection's. A tend job follows the pull request it was handed.
//
// Feature: The direct source keeps a direct job's pull request to follow
//   Scenario: a done job that opened a pull request on its repository keeps it to follow
//   Scenario: one that opened none, or opened one on another repository, keeps nothing to follow
//   Scenario: a tend job keeps the pull request it was handed
//   Scenario: with no follower, nothing is followed
import { describe, expect, it } from 'vitest';
import { openedPullRequest, type DirectPullRequests } from '../../src/domain/direct-jobs.ts';
import { createDirectJobs } from '../../src/direct-jobs/index.ts';
import type { UserStore } from '../../src/domain/store.ts';
import type { DomainEvent, Job } from '../../src/domain/types.ts';

const REPO = 'owner/sandbox';
const PR = `https://github.com/${REPO}/pull/7`;

let seq = 0;
const opened = (jobId: string, url: string, repo = REPO, op = 'pr.create'): DomainEvent => {
  seq += 1;
  return { seq, schemaVersion: 1, id: `e${seq}`, type: 'github_proxy.done', at: '2026-10-16T10:00:00.000Z', jobId, data: { op, repo, url } };
};

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'scripted', payload: {}, goal: 'A direct job' }, priority: 50, status: 'finished', approved: false,
  createdAt: '2026-10-16T09:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z', attempts: 1,
  source: { source: 'direct', kind: 'direct', key: 'direct:d1', url: 'https://hopper.test/#direct-jobs/d1', title: 'A direct job', repo: REPO, origin: 'trusted' },
  ...over,
});

const follower: DirectPullRequests = {
  follow: async () => undefined, mergesOnReady: () => true, tendStarted: async () => undefined, checkLogs: async (f) => [...f],
  endedPullRequests: async () => [], endedWatched: async () => [],
  waitedChecks: async (repo, number) => ({ url: `https://github.com/${repo}/pull/${number}`, state: 'open' }), waitedReviews: async (repo, number) => ({ url: `https://github.com/${repo}/pull/${number}`, state: 'open' }),
};

function source(events: DomainEvent[], jobs: Job[], pullRequests: DirectPullRequests | null = follower) {
  const store = {
    events: { recent: (_n: number, _types: string[], jobId: string) => events.filter((e) => e.jobId === jobId) },
    jobs: { get: (id: string) => jobs.find((j) => j.id === id) },
  } as unknown as UserStore;
  return createDirectJobs({
    store, host: () => { throw new Error('no host'); }, url: (id) => id, artifactUrl: (id) => id, now: () => '2026-10-16T10:00:00.000Z',
    ...(pullRequests ? { pullRequests } : {}),
  }).source;
}

describe('the pull request a direct job opened (issue #1068)', () => {
  it('is the newest pr.create on its repository', () => {
    const older = opened('j1', `https://github.com/${REPO}/pull/6`);
    const newer = opened('j1', PR);
    expect(openedPullRequest([newer, older], REPO)).toBe(PR);
    expect(openedPullRequest([newer], 'OWNER/Sandbox')).toBe(PR);
  });

  it('is none for another repository or another op', () => {
    expect(openedPullRequest([opened('j1', 'https://github.com/owner/other/pull/1', 'owner/other'), opened('j1', PR, REPO, 'pr.view')], REPO)).toBeUndefined();
  });
});

describe('the direct source\'s report of a done job (issue #1068)', () => {
  it('keeps the pull request the job opened to follow', async () => {
    const j = job('j1');
    expect(await source([opened('j1', PR)], [j]).report({ kind: 'finished', job: j })).toEqual({ reported: 'finished', pullRequest: PR, follow: 'open' });
  });

  it('keeps nothing to follow when it opened none, or for a failed job', async () => {
    const j = job('j1');
    expect(await source([], [j]).report({ kind: 'finished', job: j })).toEqual({ reported: 'finished' });
    expect(await source([opened('j1', PR)], [j]).report({ kind: 'failed', job: { ...j, status: 'failed' } })).toEqual({ reported: 'failed' });
  });

  it('a tend job keeps the pull request it was handed', async () => {
    const tended = job('j1', { sourceState: { source: { pullRequest: PR, follow: 'tended', tended: { pullRequest: PR, step: 'fix_checks', nextJobId: 'j2' } } } });
    const tend = job('j2', { rerunOf: 'j1' });
    expect(await source([], [tended, tend]).report({ kind: 'finished', job: tend })).toEqual({ reported: 'finished', pullRequest: PR, follow: 'open' });
  });

  it('follows through the user\'s GitHub connection; with none, follows nothing', async () => {
    const s = source([], []);
    expect(s.follow).toBe(follower.follow);
    expect(s.mergesOnReady?.(REPO)).toBe(true);
    const none = source([opened('j1', PR)], [job('j1')], null);
    expect(none.follow).toBeUndefined();
    expect(await none.report({ kind: 'finished', job: job('j1') })).toEqual({ reported: 'finished' });
  });
});
