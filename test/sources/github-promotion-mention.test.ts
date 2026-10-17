// A pull request from a release branch (issue #876) — a promotion of `dev` into `beta`, one whose body lists the issues it
// carries — only mentions each issue: it is no issue's work. It never makes an issue done, is never followed for it, and
// its merge never closes it.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
// The source's clock is 2026-10-02T10:00: a pull request opened at 09:50 with no checks is past the grace window.
const LONG_AGO = '2026-10-02T09:50:00.000Z';
const PROMOTION = { headRef: 'dev', base: 'beta', body: 'Promote dev to beta.\n\n- #1\n- #2' };

function withIssue(o: Parameters<typeof setup>[1] = {}) {
  const s = setup({}, o);
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('a promotion pull request that mentions the issue, whose job opened no pull request (issue #876)', () => {
  it('open and ready: the issue is not done, and the miss says no pull request was found', async () => {
    const { gh, source } = withIssue();
    gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, ...PROMOTION });
    expect(await source.notComplete!(jobForIssue(1))).toMatch(/no pull request in .* closes or references it/);
  });

  it('merged since the job began: the issue is not done', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, ...PROMOTION });
    gh.mergePullRequest(pr.url, AFTER);
    expect(await source.notComplete!(jobForIssue(1))).toBeDefined();
  });

  it('the finished report names no pull request to follow', async () => {
    const { gh, source } = withIssue();
    gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, ...PROMOTION });
    expect(await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) })).toEqual({ follow: 'open' });
  });

  it('the follow finds no pull request for it', async () => {
    const { gh, source } = withIssue();
    gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, ...PROMOTION });
    expect(await source.follow!(jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open' } } }))).toBeUndefined();
  });

  it('the hopper\'s own merge of it in yolo mode leaves the issue open, with no comment', async () => {
    const { gh, source } = withIssue({ yoloMode: () => true });
    const pr = gh.openReferencingPullRequest(REPO, 1, { createdAt: LONG_AGO, ...PROMOTION });
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'open' } } });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', part: true });
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(gh.calls.filter((c) => c.method === 'closeAsCompleted')).toEqual([]);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
  });

  it('a pull request of a job branch that only mentions the issue is still its work', async () => {
    const { gh, source } = withIssue();
    gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, headRef: 'fix-thing', base: 'main', body: 'Refs #1' });
    expect(await source.notComplete!(jobForIssue(1))).toBeUndefined();
  });
});
