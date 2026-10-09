// The GitHub source's definition of done (issues #171, #187, #579): a job that ended done is complete
// when its own pull request closing the issue is open and ready for review — not a draft, no merge
// conflicts — or merged. Its own: opened at or after the job's createdAt. Or, no pull request closing
// it, the issue closed as completed at or after the job's createdAt, by a commit or with no code at
// all (issue #350). A merge is never needed (issue #579).
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

describe('done is a pull request (issue #579)', () => {
  const NOT_DONE = `no pull request opened by this job, ready for review, closes ${URL1}`;

  it('the job\'s own open pull request, not a draft, closing the issue on merge is done: no merge is needed', async () => {
    const { gh, source, job } = withIssue();
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a merged pull request is done too: it went further', async () => {
    const { gh, source, job } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it.each([
    ['no pull request', () => undefined],
    ['a draft', { createdAt: AFTER, isDraft: true }],
    ['a pull request with merge conflicts', { createdAt: AFTER, conflicting: true }],
    ['a pull request opened before the job began', { createdAt: BEFORE }],
  ] as const)('%s is not done', async (_n, pr) => {
    const { gh, source, job } = withIssue();
    if (typeof pr === 'object') gh.openPullRequest(REPO, 1, pr);
    expect(await source.notComplete!(job)).toBe(NOT_DONE);
  });

  it('a pull request merged before the job began is not the job\'s', async () => {
    const { gh, source, job } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: BEFORE, mergedAt: BEFORE });
    expect(await source.notComplete!(job)).toBe(NOT_DONE);
  });

  it('an error asking GitHub throws: the engine fails the job, never records it done', async () => {
    const { gh, source, job } = withIssue();
    gh.failNext('openClosingPullRequests', new GitHubApiError('gh: timeout', false));
    await expect(source.notComplete!(job)).rejects.toThrow('gh: timeout');
  });
});

describe('closed as complete (issue #350)', () => {
  it('the issue closed as completed after the job was created, with no pull request, is complete', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: AFTER });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('closed as not planned is not complete', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: AFTER, reason: 'not_planned' });
    expect(await source.notComplete!(job)).toBe(`no pull request opened by this job, ready for review, closes ${URL1}`);
  });

  it('closed as completed before the job was created is not the job\'s', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: BEFORE });
    expect(await source.notComplete!(job)).toBe(`no pull request opened by this job, ready for review, closes ${URL1}`);
  });

  it('closedAsComplete: a failed job whose issue was closed as complete after it was created; an open issue, one closed as not planned, or by an older pull request, is not', async () => {
    const { gh, source } = setup();
    for (let n = 1; n <= 5; n++) gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    gh.closeIssue(REPO, 2, 'owner', { at: AFTER });
    gh.closeIssue(REPO, 3, 'owner', { at: AFTER, reason: 'not_planned' });
    gh.closeByPullRequest(REPO, 5, { createdAt: BEFORE, mergedAt: AFTER });
    const failed = (n: number) => jobForIssue(n, { status: 'failed' });
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => source.closedAsComplete!(failed(n))))).toEqual([true, true, false, false, false]);
  });

  it('closedAsComplete: a permanent error (an issue gone) is not; a transient error throws, to be asked again', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.deleteIssue(REPO, 1);
    expect(await source.closedAsComplete!(jobForIssue(1, { status: 'failed' }))).toBe(false);
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.failNext('getIssue', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    await expect(source.closedAsComplete!(jobForIssue(1, { status: 'failed' }))).rejects.toThrow('Bad Gateway');
  });

  it('itemClosed (issue #529): an issue closed any way, or gone, is closed; an open one is not; a transient error throws', async () => {
    const { gh, source } = setup();
    for (let n = 1; n <= 4; n++) gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 1, 'owner', { at: AFTER });
    gh.closeIssue(REPO, 2, 'owner', { at: AFTER, reason: 'not_planned' });
    gh.deleteIssue(REPO, 4);
    const failed = (n: number) => jobForIssue(n, { status: 'failed' });
    expect(await Promise.all([1, 2, 3, 4].map((n) => source.itemClosed!(failed(n))))).toEqual([true, true, false, true]);
    gh.failNext('getIssue', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    await expect(source.itemClosed!(failed(3))).rejects.toThrow('Bad Gateway');
  });
});
