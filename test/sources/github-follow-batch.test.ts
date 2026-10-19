// A follow reads the batch first (issue #985, the in-motion cycle): the GitHub source reads the pull requests its jobs follow
// in one batched read (`readFollowed`), and each follow after it takes its pull request's state from that read. It goes to
// GitHub only when something changed — merged, closed, a new head, base or merge conflicts, checks that fail now, its issue
// closed as not planned — or before a write: the hopper's merge. A follow with no batch reads GitHub as before.
import { describe, expect, it } from 'vitest';
import type { Job, PullRequestSeen } from '../../src/domain/types.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';
const LATER = '2026-10-02T12:00:00.000Z';

function waiting(o: Parameters<typeof setup>[1] = {}) {
  const s = setup({}, o);
  s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:pr-ready'] });
  const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AFTER, checks: 'pending' });
  const job = (seen?: PullRequestSeen): Job => jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'open', ...(seen ? { seen } : {}) } } });
  return { ...s, pr, job };
}

const asked = (gh: { calls: { method: string }[] }) => gh.calls.map((c) => c.method);

/** Follow once with no batch, so what is seen is kept: the job as the sync loop would have it after. */
async function seenOnce(s: ReturnType<typeof waiting>): Promise<Job> {
  const r = await s.source.follow!(s.job());
  return s.job(r!.state.seen as PullRequestSeen);
}

describe('a follow after the batch', () => {
  it('nothing changed: one batched read for every followed pull request, and no other read', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.calls.length = 0;
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toBeUndefined();
    expect(asked(s.gh)).toEqual(['pullRequestStates']);
  });

  it('its checks passed: what is seen is kept from the batch, with no other read', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.setChecks(s.pr.url, 'passing');
    s.gh.calls.length = 0;
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { checks: 'passing', pushedAt: AFTER } } });
    expect(asked(s.gh)).toEqual(['pullRequestStates']);
  });

  it('its checks fail now: read from GitHub, so the tend is told which checks failed', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.setChecks(s.pr.url, 'failing', [{ name: 'test' }]);
    s.gh.calls.length = 0;
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { checks: 'failing', failedChecks: [{ name: 'test' }] } } });
    expect(asked(s.gh)).toContain('pullRequest');
  });

  it('a new head or merge conflicts: read from GitHub', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.pushToPullRequest(s.pr.url, LATER, { conflicting: true });
    s.gh.calls.length = 0;
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { conflicting: true, pushedAt: LATER } } });
    expect(asked(s.gh)).toContain('pullRequest');
  });

  it('merged on GitHub: read from GitHub, and the item is done', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.mergePullRequest(s.pr.url);
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'merged', pullRequest: s.pr.url });
    expect(s.gh.issue(REPO, 1).labels).toContain('hopper:done');
  });

  it('its issue closed as not planned: the follow ends abandoned', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    s.gh.closeIssue(REPO, 1, 'owner', { reason: 'not_planned' });
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'abandoned' });
  });

  it('ready with yolo mode on: read from GitHub before the merge, then merged', async () => {
    const s = waiting({ yoloMode: () => true });
    const job = await seenOnce(s);
    s.gh.setChecks(s.pr.url, 'passing');
    s.gh.calls.length = 0;
    await s.source.readFollowed!([job]);
    expect(await s.source.follow!(job)).toMatchObject({ outcome: 'merged', byHopper: true });
    expect(asked(s.gh).indexOf('pullRequest')).toBeLessThan(asked(s.gh).indexOf('merge'));
  });

  it('a batch answer is used once: the next follow with no batch reads GitHub', async () => {
    const s = waiting();
    const job = await seenOnce(s);
    await s.source.readFollowed!([job]);
    await s.source.follow!(job);
    s.gh.calls.length = 0;
    await s.source.follow!(job);
    expect(asked(s.gh)).toContain('pullRequest');
  });

  it('only jobs that follow an open pull request are asked; none is no read', async () => {
    const s = waiting();
    await s.source.readFollowed!([jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: s.pr.url, follow: 'merged' } } })]);
    expect(asked(s.gh)).toEqual([]);
  });
});

describe('reconciling reads the open pull requests of every repository in one batched read', () => {
  it('a done job that follows none is answered its issue\'s open pull request, with no listing of each repository', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const found = await s.source.unfollowedPullRequests!([jobForIssue(1, { status: 'finished' })]);
    expect(found).toEqual([{ jobId: expect.any(String), pullRequest: pr.url, part: false }]);
    expect(asked(s.gh)).toContain('openPullRequestsIn');
    expect(asked(s.gh)).not.toContain('openPullRequests');
  });

  it('a batch run that closes the issue in its text is no issue\'s work (issue #2132): never answered', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    s.gh.openPullRequest(REPO, 1, { createdAt: AFTER, base: 'dev', headRef: 'hopper-batch/abc123def456', body: 'A batch run.\n\nCloses #1' });
    expect(await s.source.unfollowedPullRequests!([jobForIssue(1, { status: 'finished' })])).toEqual([]);
  });
});
