// The GitHub source's definition of done (issues #171, #187): a job that ended done is complete
// only when its own pull request reached the issue's completion — merged (`merge`), or open and
// ready for review (`pull-request`). Its own: opened at or after the job's createdAt.
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const URL1 = `https://github.com/${REPO}/issues/1`;
const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue(over: Record<string, unknown> = {}, labels: string[] = ['hopper']) {
  const s = setup(over);
  s.gh.createIssue({ repo: REPO, labels });
  return { ...s, job: jobForIssue(1) };
}

describe('completion: merge (the default)', () => {
  it('the job\'s own merged pull request closing the issue is complete', async () => {
    const { gh, source, job } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('an open pull request is not complete', async () => {
    const { gh, source, job } = withIssue();
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBe(`no merged pull request opened by this job closes ${URL1}`);
  });

  it('a pull request merged before the job began is not the job\'s', async () => {
    const { gh, source, job } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: BEFORE, mergedAt: BEFORE });
    expect(await source.notComplete!(job)).toBe(`no merged pull request opened by this job closes ${URL1}`);
  });

  it('hopper:complete-at-merge on the issue holds a pull-request source to the merge', async () => {
    const { gh, source, job } = withIssue({ completion: 'pull-request' }, ['hopper', 'hopper:complete-at-merge']);
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBe(`no merged pull request opened by this job closes ${URL1}`);
  });
});

describe('completion: pull-request', () => {
  it('the job\'s own open pull request, not a draft, closing the issue on merge is complete', async () => {
    const { gh, source, job } = withIssue({ completion: 'pull-request' });
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a merged pull request is complete too: it went further', async () => {
    const { gh, source, job } = withIssue({ completion: 'pull-request' });
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it.each([
    ['no pull request', () => undefined],
    ['a draft', { createdAt: AFTER, isDraft: true }],
    ['a pull request opened before the job began', { createdAt: BEFORE }],
  ] as const)('%s is not complete', async (_n, pr) => {
    const { gh, source, job } = withIssue({ completion: 'pull-request' });
    if (typeof pr === 'object') gh.openPullRequest(REPO, 1, pr);
    expect(await source.notComplete!(job)).toBe(`no pull request opened by this job, ready for review, closes ${URL1}`);
  });

  it('hopper:complete-at-pr on the issue lets a merge source stop at the pull request', async () => {
    const { gh, source, job } = withIssue({}, ['hopper', 'hopper:complete-at-pr']);
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('an error asking GitHub throws: the engine fails the job, never records it done', async () => {
    const { gh, source, job } = withIssue({ completion: 'pull-request' });
    gh.failNext('openClosingPullRequests', new GitHubApiError('gh: timeout', false));
    await expect(source.notComplete!(job)).rejects.toThrow('gh: timeout');
  });
});
