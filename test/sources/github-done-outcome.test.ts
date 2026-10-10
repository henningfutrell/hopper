// Done is decided from what GitHub shows, not from what the job did (issue #637): the issue closed as completed by
// anyone at any time; or a pull request of its repo that closes or references the issue, open and ready for review, or
// merged since the job began, whoever opened it and whenever; or, for an issue that asks to update pull requests it
// names, each of them free of merge conflicts or merged, pushed to or not. A miss says what was looked at.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue(o: { title?: string; body?: string } = {}) {
  const s = setup();
  const issue = s.gh.createIssue({ repo: REPO, labels: ['hopper'], ...o });
  return { ...s, issue, job: jobForIssue(issue.number) };
}

describe('done from GitHub state (issue #637)', () => {
  it('test 1 — a run again pushes to an older pull request that closes the issue: done', async () => {
    const { gh, source, job } = withIssue();
    const older = gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.pushToPullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('test 2 — the job\'s older pull request merged before the done-check ran: done', async () => {
    const { gh, source, job } = withIssue();
    const older = gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.mergePullRequest(older.url, AFTER);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('test 3 — the issue closed by another pull request (another author, another run, opened before the job): done', async () => {
    const { gh, source, job } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: BEFORE, mergedAt: BEFORE });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('the issue closed as completed by hand before the done-check, at any time: done', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: BEFORE });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('closed as not planned stays not done', async () => {
    const { gh, source, job } = withIssue();
    gh.closeIssue(REPO, 1, 'owner', { at: AFTER, reason: 'not_planned' });
    expect(await source.notComplete!(job)).toMatch(/closed as not planned/);
  });

  it('an older open pull request that closes the issue, nobody pushed to it since the job began (a push with no new commit): done', async () => {
    const { gh, source, job } = withIssue();
    gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a pull request that only references the issue ("Refs #N"), open and ready: done', async () => {
    const { gh, source, job } = withIssue();
    gh.openReferencingPullRequest(REPO, 1, { createdAt: BEFORE });
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('a pull request that references the issue, merged before the job began while the issue stays open, is not the job\'s work', async () => {
    const { gh, source, job } = withIssue();
    const pr = gh.openReferencingPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.mergePullRequest(pr.url, BEFORE);
    expect(await source.notComplete!(job)).toBeDefined();
  });

  it('a pull request that ships only part of the issue is not the whole issue done', async () => {
    const { gh, source, job } = withIssue();
    gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.notComplete!(job)).toBeDefined();
  });

  it.each([
    ['a draft', { isDraft: true }, 'draft'],
    ['a pull request with merge conflicts', { conflicting: true }, 'merge conflicts'],
  ] as const)('%s is not done, and the miss names it', async (_n, pr, why) => {
    const { gh, source, job } = withIssue();
    const p = gh.openPullRequest(REPO, 1, { createdAt: AFTER, ...pr });
    const miss = await source.notComplete!(job);
    expect(miss).toContain(`#${p.url.split('/').at(-1)} (open, ${why})`);
  });

  it('no pull request: the miss says the issue is open and that no pull request was found', async () => {
    const { source, job, issue } = withIssue();
    expect(await source.notComplete!(job)).toBe(`the issue ${issue.url} is open, and no pull request in ${REPO} closes or references it`);
  });
});

describe('an issue that asks to update pull requests it names (issue #637)', () => {
  /** Two older pull requests of other issues; issue 3 asks to bring both up to date. */
  function maintenance() {
    const s = setup();
    s.gh.createIssue({ repo: REPO });
    s.gh.createIssue({ repo: REPO });
    const a = s.gh.openPullRequest(REPO, 1, { createdAt: BEFORE, conflicting: true });
    const b = s.gh.openPullRequest(REPO, 2, { createdAt: BEFORE, conflicting: true });
    const n = (u: string) => u.split('/').at(-1);
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], title: `Bring PRs #${n(a.url)} and #${n(b.url)} up to date with dev`, body: 'Leave each one mergeable.' });
    return { ...s, a, b, job: jobForIssue(3) };
  }

  it('test 4 — each named pull request merged before the job started, nothing pushed: done', async () => {
    const { gh, source, a, b, job } = maintenance();
    gh.mergePullRequest(a.url, BEFORE);
    gh.mergePullRequest(b.url, BEFORE);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('one named pull request merged, the other free of merge conflicts (already current, no push needed): done', async () => {
    const { gh, source, a, b, job } = maintenance();
    gh.mergePullRequest(a.url, BEFORE);
    gh.pushToPullRequest(b.url, BEFORE);
    expect(await source.notComplete!(job)).toBeUndefined();
  });

  it('one named pull request still with merge conflicts: not done, and the miss names it', async () => {
    const { gh, source, a, b, job } = maintenance();
    gh.mergePullRequest(a.url, BEFORE);
    expect(await source.notComplete!(job)).toContain(`#${b.url.split('/').at(-1)} (open, merge conflicts)`);
  });

  it('an issue that only mentions merged pull requests, and asks for no update, is not done by them', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO });
    const old = s.gh.closeByPullRequest(REPO, 1, { createdAt: BEFORE, mergedAt: BEFORE });
    s.gh.createIssue({ repo: REPO, labels: ['hopper'], title: 'Add a feature', body: `Builds on #${old.url.split('/').at(-1)}.` });
    expect(await s.source.notComplete!(jobForIssue(2))).toBeDefined();
  });
});

describe('a pull request that names the issue only in its branch name (issue #637)', () => {
  it('open and ready on a branch named for the issue (issue-N-…, N-…): done', async () => {
    for (const headRef of ['issue-1-fix-the-thing', '1-fix-the-thing', 'fix/issue-1']) {
      const { gh, source, job } = withIssue();
      gh.openUnlinkedPullRequest(REPO, { createdAt: BEFORE, headRef });
      expect(await source.notComplete!(job)).toBeUndefined();
    }
  });

  it('a branch named for another issue, or a draft on this one\'s: not done, and the miss names the draft', async () => {
    const { gh, source, job } = withIssue();
    gh.openUnlinkedPullRequest(REPO, { createdAt: BEFORE, headRef: 'issue-12-other' });
    gh.openUnlinkedPullRequest(REPO, { createdAt: BEFORE, headRef: 'fix-1234' });
    expect(await source.notComplete!(job)).toMatch(/no pull request in .* closes or references it$/);
    const draft = gh.openUnlinkedPullRequest(REPO, { createdAt: BEFORE, headRef: 'issue-1-wip', isDraft: true });
    expect(await source.notComplete!(job)).toContain(`#${draft.url.split('/').at(-1)} (open, draft)`);
  });
});
