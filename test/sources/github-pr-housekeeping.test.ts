// Pull request housekeeping (issue #1143): the follow of a job's open pull request does two things itself, with no job.
// A pull request whose base is not the repository's landing branch (its landing batch setting, issue #1142) and not the head of another open
// pull request (a stack) moves to the landing branch. A pull request with nothing left to land — its issue closed as
// completed by another pull request, or no commit its base lacks — is closed. Each act leaves one comment on the pull
// request that says what the hopper did and why.
import { describe, expect, it } from 'vitest';
import type { Job, PullRequestSeen } from '../../src/domain/types.ts';
import { retargetNote, supersededNote } from '../../src/sources/github/pr-notes.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const LATER = '2026-10-02T12:00:00.000Z';
const numberOf = (url: string) => Number(url.slice(url.lastIndexOf('/') + 1));

function waiting(pr: { base?: string; headRef?: string; commits?: string[]; part?: boolean } = {}, landing?: string) {
  const s = setup({}, landing ? { landingBranch: (repo) => (repo === REPO ? landing : undefined) } : {});
  s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:pr-ready'] });
  const open = pr.part ? s.gh.openPartPullRequest : s.gh.openPullRequest;
  const made = open(REPO, 1, { createdAt: AFTER, checks: 'passing', ...pr });
  const job = (seen?: PullRequestSeen): Job => jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: made.url, follow: 'open', ...(pr.part ? { part: true } : {}), ...(seen ? { seen } : {}) } } });
  return { ...s, pr: made, job };
}

describe('a job\'s pull request off the landing branch', () => {
  it('moves to the landing branch, with one comment that says so; it is not merged in the same follow', async () => {
    const s = waiting({ base: 'dev' }, 'main');
    const r = await s.source.follow!(s.job());
    expect(r).toMatchObject({ outcome: 'open', retargeted: { from: 'dev', to: 'main' }, state: { seen: { base: 'main' } } });
    expect(s.gh.calls.filter((c) => c.method === 'retarget').map((c) => c.args)).toEqual([[REPO, numberOf(s.pr.url), 'main']]);
    expect(s.gh.pullRequestComments(s.pr.url)).toEqual([retargetNote('dev', 'main')]);
    expect(s.gh.calls.some((c) => c.method === 'merge')).toBe(false);
  });

  it('once moved, a later follow moves nothing and says nothing more', async () => {
    const s = waiting({ base: 'dev' }, 'main');
    const r = await s.source.follow!(s.job());
    await s.source.follow!(s.job(r!.state.seen as PullRequestSeen));
    expect(s.gh.calls.filter((c) => c.method === 'retarget')).toHaveLength(1);
    expect(s.gh.pullRequestComments(s.pr.url)).toHaveLength(1);
  });

  it('stacked on another open pull request (its base is that one\'s head): left as it is', async () => {
    const s = waiting({ base: 'feature-a' }, 'main');
    s.gh.openUnlinkedPullRequest(REPO, { createdAt: AFTER, headRef: 'feature-a', base: 'main' });
    const r = await s.source.follow!(s.job());
    expect(r).not.toHaveProperty('retargeted');
    expect(s.gh.calls.some((c) => c.method === 'retarget')).toBe(false);
  });

  it('a repository with no landing batches: left as it is, whatever GitHub\'s default branch (issue #1142)', async () => {
    const s = waiting({ base: 'dev' });
    const r = await s.source.follow!(s.job());
    expect(r).not.toHaveProperty('retargeted');
    expect(s.gh.calls.some((c) => c.method === 'retarget')).toBe(false);
  });

  it('after the batch: a base off the landing branch is read from GitHub, and moved', async () => {
    const at: { landing?: string } = {};
    const s = setup({}, { landingBranch: () => at.landing });
    s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:pr-ready'] });
    const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AFTER, checks: 'passing', base: 'dev' });
    const job = (seen?: PullRequestSeen): Job => jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'open', ...(seen ? { seen } : {}) } } });
    const seen = (await s.source.follow!(job()))!.state.seen as PullRequestSeen;
    at.landing = 'main';
    await s.source.readFollowed!([job(seen)]);
    expect(await s.source.follow!(job(seen))).toMatchObject({ retargeted: { from: 'dev', to: 'main' } });
  });
});

describe('a superseded pull request', () => {
  it('its issue closed as completed by another pull request: closed with why; the item is done', async () => {
    const s = waiting();
    const other = s.gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: LATER });
    const r = await s.source.follow!(s.job());
    expect(r).toMatchObject({ outcome: 'closed', pullRequest: s.pr.url, superseded: `its issue was closed by ${other.url}` });
    expect(s.gh.calls.filter((c) => c.method === 'closeWithoutMerge').map((c) => c.args)).toEqual([[REPO, numberOf(s.pr.url)]]);
    expect(s.gh.pullRequestComments(s.pr.url)).toEqual([supersededNote(`its issue was closed by ${other.url}`)]);
    expect(s.gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('no commit its base lacks: closed with why; the item is flagged hopper:pr-closed for a person', async () => {
    const s = waiting({ commits: [] });
    const r = await s.source.follow!(s.job());
    expect(r).toMatchObject({ outcome: 'closed', superseded: 'its changes are already on dev' });
    expect(s.gh.pullRequestComments(s.pr.url)).toEqual([supersededNote('its changes are already on dev')]);
    expect(s.gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('a part is not superseded by its issue\'s close: it is followed as before', async () => {
    const s = waiting({ part: true });
    s.gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: LATER });
    const r = await s.source.follow!(s.job());
    expect(r).not.toHaveProperty('superseded');
    expect(s.gh.calls.some((c) => c.method === 'closeWithoutMerge')).toBe(false);
  });

  it('commits its base lacks, and its issue open: not superseded', async () => {
    const s = waiting({ commits: ['abc1234 change'] });
    const r = await s.source.follow!(s.job());
    expect(r).toMatchObject({ outcome: 'open' });
    expect(s.gh.calls.some((c) => c.method === 'closeWithoutMerge')).toBe(false);
  });
});
