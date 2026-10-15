// The census of open pull requests (issue #1176): in a round of every follow, the source reads the open pull requests of its
// job repositories and lists the untracked ones in its status, each with why. One of an item the ledger holds, on a base
// from before the landing branch, on a branch named for its issue (a job's), moves to the landing branch with the follow's
// note; one on a person's branch stays as it is.
import { describe, expect, it } from 'vitest';
import type { CensusFacts } from '../../src/domain/untracked-pull-requests.ts';
import { retargetNote } from '../../src/sources/github/pr-notes.ts';
import { REPO, setup } from './fixtures/github-support.ts';

const AT = '2026-10-02T11:00:00.000Z';
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const facts = (o: { tracked?: string[]; items?: number[]; followed?: Record<number, string> } = {}): Omit<CensusFacts, 'landing'> => ({
  tracked: (u) => (o.tracked ?? []).includes(u),
  issueTracked: (u) => (o.items ?? []).some((n) => issueUrl(n) === u),
  followedOf: (u) => Object.entries(o.followed ?? {}).find(([n]) => issueUrl(Number(n)) === u)?.[1],
});

async function census(landing?: string) {
  const s = setup({}, landing ? { landingBranch: () => landing } : {});
  for (let i = 0; i < 3; i++) s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  s.gh.createIssue({ repo: REPO });
  await s.source.discover();
  return s;
}
const untracked = (s: Awaited<ReturnType<typeof census>>) => s.source.describe().untrackedPullRequests;

describe('the census of open pull requests (issue #1176)', () => {
  it('lists each untracked one with why, and not one a job names', async () => {
    const s = await census('main');
    const named = s.gh.openPullRequest(REPO, 1, { createdAt: AT, base: 'main' });
    const unlabelled = s.gh.openPullRequest(REPO, 4, { createdAt: AT, base: 'main' });
    const none = s.gh.openUnlinkedPullRequest(REPO, { createdAt: AT, headRef: 'chore', base: 'main' });
    const person = s.gh.openPullRequest(REPO, 2, { createdAt: AT, base: 'main', headRef: 'my-fix' });
    await s.source.censusPullRequests!(facts({ tracked: [named.url], items: [1, 2] }));
    expect(untracked(s)).toEqual([
      expect.objectContaining({ url: unlabelled.url, issue: { number: 4, url: issueUrl(4), part: false }, reason: 'issue_not_in_intake' }),
      expect.objectContaining({ url: none.url, reason: 'no_issue' }),
      expect.objectContaining({ url: person.url, reason: 'not_by_a_job' }),
    ]);
  });

  it('a job\'s branch on a base from before: moved to the landing branch, with one note, and listed as moved', async () => {
    const s = await census('main');
    const pr = s.gh.openPartPullRequest(REPO, 3, { createdAt: AT, base: 'dev', headRef: 'issue-3-part' });
    await s.source.censusPullRequests!(facts({ items: [3] }));
    expect(s.gh.calls.filter((c) => c.method === 'retarget').map((c) => c.args)).toEqual([[REPO, Number(pr.url.split('/').pop()), 'main']]);
    expect(s.gh.pullRequestComments(pr.url)).toEqual([retargetNote('dev', 'main')]);
    expect(untracked(s)).toEqual([expect.objectContaining({ url: pr.url, base: 'main', reason: 'not_by_a_job', retargeted: { from: 'dev', to: 'main' } })]);
    await s.source.censusPullRequests!(facts({ items: [3] }));
    expect(s.gh.calls.filter((c) => c.method === 'retarget')).toHaveLength(1);
  });

  it('a job\'s branch on a base from before, of an item whose job follows another: moved, and listed as a second pull request', async () => {
    const s = await census('main');
    const pr = s.gh.openPartPullRequest(REPO, 3, { createdAt: AT, base: 'dev', headRef: 'issue-3-part' });
    const other = `https://github.com/${REPO}/pull/99`;
    await s.source.censusPullRequests!(facts({ items: [3], followed: { 3: other } }));
    expect(untracked(s)).toEqual([expect.objectContaining({ url: pr.url, base: 'main', reason: 'second_pull_request', followed: other, retargeted: { from: 'dev', to: 'main' } })]);
  });

  it('a person\'s branch on a base from before: left as it is, listed with the wrong base', async () => {
    const s = await census('main');
    const pr = s.gh.openPullRequest(REPO, 3, { createdAt: AT, base: 'dev', headRef: 'my-fix' });
    await s.source.censusPullRequests!(facts({ items: [3] }));
    expect(s.gh.calls.some((c) => c.method === 'retarget')).toBe(false);
    expect(untracked(s)).toEqual([expect.objectContaining({ url: pr.url, base: 'dev', reason: 'wrong_base' })]);
  });

  it('no landing batches: nothing is moved', async () => {
    const s = await census();
    s.gh.openPullRequest(REPO, 3, { createdAt: AT, base: 'dev', headRef: 'issue-3' });
    await s.source.censusPullRequests!(facts({ items: [3] }));
    expect(s.gh.calls.some((c) => c.method === 'retarget')).toBe(false);
    expect(untracked(s)).toEqual([expect.objectContaining({ reason: 'not_by_a_job' })]);
  });

  it('every one tracked: nothing is listed', async () => {
    const s = await census('main');
    const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AT, base: 'main' });
    await s.source.censusPullRequests!(facts({ tracked: [pr.url], items: [1] }));
    expect(s.source.describe()).not.toHaveProperty('untrackedPullRequests');
  });
});
