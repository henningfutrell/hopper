// The GitHub source's definition of done (issues #171, #187, #579, #637): a job that ended done is complete
// when a pull request closing the issue is open and ready for review — not a draft, no merge
// conflicts — or merged; or the issue is closed as completed (issue #350). A merge is never needed (issue #579).
// What GitHub shows decides, not what the job did (issue #637, `github-done-outcome.test.ts`).
import { describe, expect, it } from 'vitest';
import { finishBrief, judge } from '../../src/domain/types.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, jobForIssue, setup, type FakeGitHub } from './fixtures/github-support.ts';

const URL1 = `https://github.com/${REPO}/issues/1`;
const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue(over: Record<string, unknown> = {}, labels: string[] = ['hopper']) {
  const s = setup(over);
  s.gh.createIssue({ repo: REPO, labels });
  return { ...s, job: jobForIssue(1) };
}

const notDone = (url: string) => expect.stringMatching(new RegExp(`^the issue ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is `));

describe('done is a pull request (issue #579)', () => {
  const NOT_DONE = notDone(URL1);

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
  ] as const)('%s is not done', async (_n, pr) => {
    const { gh, source, job } = withIssue();
    if (typeof pr === 'object') gh.openPullRequest(REPO, 1, pr);
    expect(await source.notComplete!(job)).toEqual(NOT_DONE);
  });

  it('an error asking GitHub throws: the engine fails the job, never records it done', async () => {
    const { gh, source, job } = withIssue();
    gh.failNext('openClosingPullRequests', new GitHubApiError('gh: timeout', false));
    await expect(source.notComplete!(job)).rejects.toThrow('gh: timeout');
  });
});

describe('a job that updates an existing pull request (issue #618)', () => {
  const URL2 = `https://github.com/${REPO}/issues/2`;
  /** Issue 1's pull request, opened before the job; issue 2 asks to bring it up to date, naming it by `name`. */
  function maintenance(name: (pr: { url: string; number: number }) => string, pr: { isDraft?: boolean } = {}) {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const older = s.gh.openPullRequest(REPO, 1, { createdAt: BEFORE, ...pr });
    const number = Number(older.url.split('/').at(-1));
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], body: `Bring ${name({ url: older.url, number })} up to date with dev and fix its conflicts.` });
    return { ...s, older, job: jobForIssue(2) };
  }

  it.each([
    ['by its number', (pr: { number: number }) => `#${pr.number}`],
    ['by its URL', (pr: { url: string }) => pr.url],
  ])('the pull request the issue names %s, pushed to by the job and free of merge conflicts, is done: no new pull request is needed', async (_n, name) => {
    const { gh, source, older, job } = maintenance(name);
    gh.pushToPullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a draft the issue names is done too once updated: the job keeps the pull request as it found it', async () => {
    const { gh, source, older, job } = maintenance((pr) => `#${pr.number}`, { isDraft: true });
    gh.pushToPullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('merged by the job after it updated it (yolo mode) is done', async () => {
    const { gh, source, older, job } = maintenance((pr) => `#${pr.number}`);
    gh.pushToPullRequest(older.url, AFTER);
    gh.mergePullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it.each([
    ['still with merge conflicts', (gh: FakeGitHub, url: string) => gh.pushToPullRequest(url, AFTER, { conflicting: true })],
    ['closed without a merge', (gh: FakeGitHub, url: string) => { gh.pushToPullRequest(url, AFTER); gh.closePullRequest(url); }],
  ])('the pull request the issue names, %s, is not done', async (_n, act) => {
    const { gh, source, older, job } = maintenance((pr) => `#${pr.number}`);
    act(gh, older.url);
    expect(await source.notComplete!(job)).toEqual(notDone(URL2));
  });

  it('a number that names an issue, not a pull request, is not done', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], body: 'Bring #1 up to date.' });
    expect(await s.source.notComplete!(jobForIssue(2))).toEqual(notDone(URL2));
  });

  it('an older pull request that closes the issue — a run again goes on with it — pushed to by the job, ready and free of merge conflicts, is done', async () => {
    const { gh, source, job } = withIssue();
    const older = gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.pushToPullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('an older pull request that closes the issue, a draft, is not done', async () => {
    const { gh, source, job } = withIssue();
    const older = gh.openPullRequest(REPO, 1, { createdAt: BEFORE, isDraft: true });
    gh.pushToPullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toEqual(notDone(URL1));
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
    expect(await source.notComplete!(job)).toEqual(notDone(URL1));
  });

  it('closed as completed before the job was created is done too (issue #637): what GitHub shows decides', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: BEFORE });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('closedAsComplete: a failed job whose issue was closed as complete, by any pull request or by hand (issue #637); an open issue or one closed as not planned is not', async () => {
    const { gh, source } = setup();
    for (let n = 1; n <= 5; n++) gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    gh.closeIssue(REPO, 2, 'owner', { at: AFTER });
    gh.closeIssue(REPO, 3, 'owner', { at: AFTER, reason: 'not_planned' });
    gh.closeByPullRequest(REPO, 5, { createdAt: BEFORE, mergedAt: AFTER });
    const failed = (n: number) => jobForIssue(n, { status: 'failed' });
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => source.closedAsComplete!(failed(n))))).toEqual([true, true, false, false, true]);
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

  it('workState (issues #529, #621): an issue closed as completed is done, closed any other way is closed, deleted is gone; a transient error throws', async () => {
    const { gh, source } = setup();
    for (let n = 1; n <= 4; n++) gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 1, 'owner', { at: AFTER });
    gh.closeIssue(REPO, 2, 'owner', { at: AFTER, reason: 'not_planned' });
    gh.deleteIssue(REPO, 4);
    const failed = (n: number) => jobForIssue(n, { status: 'failed' });
    expect((await Promise.all([1, 2, 3, 4].map((n) => source.workState!(failed(n))))).map((w) => w?.item)).toEqual(['done', 'closed', 'open', 'gone']);
    gh.failNext('getIssue', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    await expect(source.workState!(failed(3))).rejects.toThrow('Bad Gateway');
  });
});

describe('what a failed job\'s work shows on GitHub (issue #621)', () => {
  const failed = (n: number) => jobForIssue(n, { status: 'failed' });
  const numberOf = (url: string) => Number(url.split('/').at(-1));

  it('no pull request: the issue open, none listed', async () => {
    const { source } = withIssue();
    expect(await source.workState!(failed(1))).toEqual({ item: 'open', pullRequests: [] });
  });

  it('the job\'s own pull request, a draft: opened, open, a draft', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, isDraft: true });
    expect(await source.workState!(failed(1))).toEqual({
      item: 'open', pullRequests: [{ url: pr.url, number: numberOf(pr.url), by: 'opened', state: 'open', draft: true, conflicting: false }],
    });
  });

  it('the job\'s own pull request merged: opened and merged, the issue done', async () => {
    const { gh, source } = withIssue();
    const pr = gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    expect(await source.workState!(failed(1))).toEqual({
      item: 'done', pullRequests: [{ url: pr.url, number: numberOf(pr.url), by: 'opened', state: 'merged', draft: false, conflicting: false }],
    });
  });

  it('a pull request the issue names, pushed to by the job and merged: updated and merged (the #613 case)', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const older = gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.createIssue({ repo: REPO, labels: ['hopper'], body: `Rebase #${numberOf(older.url)} onto dev.` });
    gh.pushToPullRequest(older.url, AFTER);
    gh.mergePullRequest(older.url, AFTER);
    expect(await source.workState!(failed(2))).toEqual({
      item: 'open', pullRequests: [{ url: older.url, number: numberOf(older.url), by: 'updated', state: 'merged', draft: false, conflicting: false }],
    });
  });

  it('an older pull request nobody pushed to since the job began is not the job\'s work', async () => {
    const { gh, source } = withIssue();
    gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    expect(await source.workState!(failed(1))).toEqual({ item: 'open', pullRequests: [] });
  });

  it('the job\'s own pull request closed without a merge: opened and closed', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    gh.closePullRequest(pr.url);
    expect((await source.workState!(failed(1)))?.pullRequests).toEqual([{ url: pr.url, number: numberOf(pr.url), by: 'opened', state: 'closed', draft: false, conflicting: false }]);
  });
});

describe('a pull request the job left in conflict or as a draft (issue #626)', () => {
  const NOT_DONE = notDone(URL1);

  it('the job\'s own pull request with merge conflicts continues the job with the rebase brief: no hand-off', async () => {
    const { gh, source, job } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, conflicting: true });
    expect(await judge(source, job)).toEqual({ done: false, why: NOT_DONE, finish: { pullRequest: pr.url, step: 'rebase' } });
  });

  it('the job\'s own draft, otherwise ready, continues the job with the mark-ready brief', async () => {
    const { gh, source, job } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, isDraft: true });
    expect(await judge(source, job)).toEqual({ done: false, why: NOT_DONE, finish: { pullRequest: pr.url, step: 'mark_ready' } });
  });

  it('a draft with merge conflicts is rebased first: a draft is marked ready only once it can merge', async () => {
    const { gh, source, job } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER, isDraft: true, conflicting: true });
    expect(await source.unfinishedPullRequest!(job)).toEqual({ pullRequest: pr.url, step: 'rebase' });
  });

  it('the job\'s own pull request that ships part of the issue, left as a draft, is marked ready too', async () => {
    const { gh, source, job } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, isDraft: true });
    expect(await source.unfinishedPullRequest!(job)).toEqual({ pullRequest: pr.url, step: 'mark_ready' });
  });

  it.each([
    ['no pull request', () => undefined],
    ['a draft opened before the job began', { createdAt: BEFORE, isDraft: true }],
    ['a pull request with merge conflicts opened before the job began', { createdAt: BEFORE, conflicting: true }],
  ] as const)('%s keeps the hand-off: the verdict has no brief', async (_n, pr) => {
    const { gh, source, job } = withIssue();
    if (typeof pr === 'object') gh.openPullRequest(REPO, 1, pr);
    expect(await judge(source, job)).toEqual({ done: false, why: NOT_DONE });
  });

  it('a pull request that is done needs no brief: the job is done', async () => {
    const { gh, source, job } = withIssue();
    gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await judge(source, job)).toEqual({ done: true });
  });

  it('the brief is fixed text: the same pull request and step give the same brief, and it names what to do', () => {
    const url = `https://github.com/${REPO}/pull/1001`;
    const rebase = finishBrief({ pullRequest: url, step: 'rebase' });
    expect(finishBrief({ pullRequest: url, step: 'rebase' })).toBe(rebase);
    expect(rebase).toContain(url);
    expect(rebase).toMatch(/rebase/i);
    expect(rebase).toContain('--force-with-lease');
    const ready = finishBrief({ pullRequest: url, step: 'mark_ready' });
    expect(ready).toContain(url);
    expect(ready).toMatch(/ready for review/i);
    expect(ready).not.toBe(rebase);
  });
});

describe('pullRequestOpen (issue #630): a liveness fact of a timed-out job', () => {
  it.each([
    ['its own open pull request', { createdAt: AFTER }, true],
    ['its own draft: it is at work', { createdAt: AFTER, isDraft: true }, true],
    ['an older one it pushed to', { createdAt: BEFORE, headCommittedAt: AFTER }, true],
    ['an older one it did not touch', { createdAt: BEFORE }, false],
  ] as const)('%s → %s', async (_n, pr, open) => {
    const { gh, source, job } = withIssue();
    gh.openPullRequest(REPO, 1, pr);
    expect(await source.pullRequestOpen!(job)).toBe(open);
  });

  it('no pull request is false; an error asking GitHub throws', async () => {
    const { gh, source, job } = withIssue();
    expect(await source.pullRequestOpen!(job)).toBe(false);
    gh.failNext('openClosingPullRequests', new GitHubApiError('gh: timeout', false));
    await expect(source.pullRequestOpen!(job)).rejects.toThrow('gh: timeout');
  });
});
