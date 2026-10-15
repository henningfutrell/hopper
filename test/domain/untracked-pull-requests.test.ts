// Untracked pull requests (issue #1176): each open pull request no job names and the ledger does not hold is listed with
// one reason — it links no issue, its issue is not in Intake, its base is not the landing branch, or no job made it.
import { describe, expect, it } from 'vitest';
import { issueOfPullRequest, untrackedPullRequests, type CensusFacts, type CensusPullRequest } from '../../src/domain/untracked-pull-requests.ts';

const REPO = 'owner/repo';
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const issue = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const pr = (n: number, body: string, o: Partial<CensusPullRequest> = {}): CensusPullRequest =>
  ({ url: url(n), body, headRef: `issue-${n}`, base: 'main', createdAt: '2026-10-14T10:00:00Z', ...o });
const facts = (o: { tracked?: string[]; items?: number[]; landing?: string; followed?: Record<number, string> } = {}): CensusFacts => ({
  tracked: (u) => (o.tracked ?? []).includes(u),
  issueTracked: (u) => (o.items ?? []).some((n) => issue(n) === u),
  followedOf: (u) => Object.entries(o.followed ?? {}).find(([n]) => issue(Number(n)) === u)?.[1],
  landing: () => o.landing,
});

describe('untracked pull requests (issue #1176)', () => {
  it('a pull request a job names, or the ledger holds, is tracked: not listed', () => {
    expect(untrackedPullRequests(REPO, [pr(10, 'Closes #1')], facts({ tracked: [url(10)], items: [1] }))).toEqual([]);
  });

  it('no linked issue: no closing keyword and no "Part of"', () => {
    expect(untrackedPullRequests(REPO, [pr(10, 'A change. Refs #1')], facts({ items: [1] })))
      .toEqual([{ repo: REPO, url: url(10), base: 'main', reason: 'no_issue' }]);
  });

  it('its issue is no work item: not in Intake (no label, no assignee)', () => {
    expect(untrackedPullRequests(REPO, [pr(1115, 'Closes #1114')], facts({ landing: 'main' }))).toEqual([
      { repo: REPO, url: url(1115), base: 'main', issue: { number: 1114, url: issue(1114), part: false }, reason: 'issue_not_in_intake', offer: 'take_in' },
    ]);
  });

  it('its issue is a work item and its base is not the landing branch: wrong base', () => {
    expect(untrackedPullRequests(REPO, [pr(1039, 'Part of #712', { base: 'dev', headRef: 'issue-712-lan-health' })], facts({ items: [712], landing: 'main' }))).toEqual([
      { repo: REPO, url: url(1039), base: 'dev', issue: { number: 712, url: issue(712), part: true }, reason: 'wrong_base' },
    ]);
  });

  it('its issue is a work item, on the landing branch, and no job names it: not by a job', () => {
    expect(untrackedPullRequests(REPO, [pr(10, 'Fixes #1', { title: 'A fix' })], facts({ items: [1], landing: 'main' }))).toEqual([
      { repo: REPO, url: url(10), title: 'A fix', base: 'main', issue: { number: 1, url: issue(1), part: false }, reason: 'not_by_a_job' },
    ]);
  });

  it('its item\'s job follows another pull request: a second pull request, which names the one followed', () => {
    expect(untrackedPullRequests(REPO, [pr(1039, 'Part of #712', { base: 'main' })], facts({ items: [712], landing: 'main', followed: { 712: url(1200) } }))).toEqual([
      { repo: REPO, url: url(1039), base: 'main', issue: { number: 712, url: issue(712), part: true }, reason: 'second_pull_request', followed: url(1200) },
    ]);
  });

  it('a second pull request on the wrong base: the wrong base first, so a job\'s branch is still moved', () => {
    expect(untrackedPullRequests(REPO, [pr(1039, 'Part of #712', { base: 'dev' })], facts({ items: [712], landing: 'main', followed: { 712: url(1200) } }))[0])
      .toMatchObject({ reason: 'wrong_base', followed: url(1200) });
  });

  it('a repository with no landing batches: no base is wrong', () => {
    expect(untrackedPullRequests(REPO, [pr(10, 'Closes #1', { base: 'dev' })], facts({ items: [1] }))[0]!.reason).toBe('not_by_a_job');
  });

  it('stacked on another open pull request (its base is that one\'s head): no wrong base', () => {
    const prs = [pr(10, 'Closes #1', { base: 'feature-a' }), pr(11, 'A change.', { headRef: 'feature-a' })];
    expect(untrackedPullRequests(REPO, prs, facts({ items: [1], tracked: [url(11)], landing: 'main' }))[0]!.reason).toBe('not_by_a_job');
  });

  it('listed by number, oldest first', () => {
    const got = untrackedPullRequests(REPO, [pr(12, 'x'), pr(3, 'y')], facts());
    expect(got.map((u) => u.url)).toEqual([url(3), url(12)]);
  });
});

describe('the issue a pull request links', () => {
  it('a closing keyword first, then "Part of"', () => {
    expect(issueOfPullRequest('Part of #7\n\nCloses #8', REPO)).toEqual({ number: 8, part: false });
    expect(issueOfPullRequest('Part of #7', REPO)).toEqual({ number: 7, part: true });
  });

  it('an issue of another repository is not its own: none', () => {
    expect(issueOfPullRequest('Closes other/repo#3', REPO)).toBeUndefined();
  });

  it('a mention, or a keyword in code, links nothing', () => {
    expect(issueOfPullRequest('See #3. `Closes #4`', REPO)).toBeUndefined();
  });
});
