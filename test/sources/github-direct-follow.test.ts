// Issue #1068: a direct job's pull request is followed. A direct job has no issue: the follow reads only its pull request,
// keeps what it sees while it is open, merges it once ready with yolo mode on, and ends when it is merged or closed. It
// never reads, labels or closes an issue.
//
// Feature: Following a direct job's pull request
//   Scenario: open, yolo mode off — what is seen of it is kept, nothing is merged
//   Scenario: open and ready, yolo mode on — the hopper merges it
//   Scenario: checks that fail — kept as seen, so the tending loop tends it; not merged
//   Scenario: merged or closed on GitHub by a person — it ends, not by the hopper
//   Scenario: a job that follows nothing — nothing is read
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/github/fake.ts';
import { followDirectPullRequest } from '../../src/sources/github/direct-follow.ts';
import type { PullRequestContext } from '../../src/sources/github/follow-context.ts';
import type { Job } from '../../src/domain/types.ts';
import { jobFor, REPO } from './fixtures/github-support.ts';

// The clock is 2026-10-02T10:00; long ago is outside the grace window for checks to start.
const LONG_AGO = '2026-10-02T09:50:00.000Z';

function setup(yolo: boolean) {
  const gh = createFakeGitHub();
  const ctx: PullRequestContext = { api: gh, ensuredLabels: new Set(), clock: { now: () => new Date('2026-10-02T10:00:00.000Z') }, yoloMode: () => yolo };
  return { gh, ctx };
}

const directJob = (state: Record<string, unknown>): Job => {
  const url = 'https://hopper.test/#direct-jobs/d1';
  return jobFor({ key: 'direct:d1', url, repo: REPO, author: 'owner', title: 'A direct job' }, { status: 'finished', sourceState: { source: state } }, 'direct');
};

const issueWrites = (gh: ReturnType<typeof createFakeGitHub>) =>
  gh.calls.filter((c) => ['getIssue', 'addLabels', 'removeLabels', 'closeIssue', 'postComment'].includes(c.method));

describe('a direct job\'s pull request (issue #1068)', () => {
  it('open, yolo mode off: what is seen of it is kept, and nothing is merged', async () => {
    const { gh, ctx } = setup(false);
    const pr = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-1', createdAt: LONG_AGO, checks: 'passing' });
    const up = await followDirectPullRequest(ctx, directJob({ reported: 'finished', pullRequest: pr.url, follow: 'open' }));
    expect(up).toMatchObject({ outcome: 'open', pullRequest: pr.url, part: false, state: { follow: 'open', seen: { draft: false, conflicting: false, checks: 'passing' } } });
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);
    expect(issueWrites(gh)).toEqual([]);
  });

  it('open and ready, yolo mode on: the hopper merges it, and no issue is closed', async () => {
    const { gh, ctx } = setup(true);
    const pr = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-1', createdAt: LONG_AGO, checks: 'passing' });
    const up = await followDirectPullRequest(ctx, directJob({ pullRequest: pr.url, follow: 'open' }));
    expect(up).toMatchObject({ outcome: 'merged', pullRequest: pr.url, byHopper: true, state: { follow: 'merged' } });
    expect(gh.calls.filter((c) => c.method === 'merge')).toHaveLength(1);
    expect(issueWrites(gh)).toEqual([]);
  });

  it('checks that fail: seen as failing, so the tending loop tends it; never merged', async () => {
    const { gh, ctx } = setup(true);
    const pr = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-1', createdAt: LONG_AGO, checks: 'failing' });
    const up = await followDirectPullRequest(ctx, directJob({ pullRequest: pr.url, follow: 'open' }));
    expect(up).toMatchObject({ outcome: 'open', state: { seen: { checks: 'failing' } } });
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);
  });

  it('seen as it was: nothing changed, nothing to keep', async () => {
    const { gh, ctx } = setup(false);
    const pr = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-1', createdAt: LONG_AGO, checks: 'passing' });
    const first = await followDirectPullRequest(ctx, directJob({ pullRequest: pr.url, follow: 'open' }));
    expect(await followDirectPullRequest(ctx, directJob(first!.state))).toBeUndefined();
  });

  it('merged or closed on GitHub by a person: it ends, not by the hopper', async () => {
    const { gh, ctx } = setup(true);
    const merged = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-1', createdAt: LONG_AGO });
    gh.mergePullRequest(merged.url);
    const closed = gh.openUnlinkedPullRequest(REPO, { headRef: 'change-2', createdAt: LONG_AGO });
    gh.closePullRequest(closed.url);
    const m = await followDirectPullRequest(ctx, directJob({ pullRequest: merged.url, follow: 'open' }));
    expect(m).toMatchObject({ outcome: 'merged', pullRequest: merged.url, state: { follow: 'merged' } });
    expect(m?.byHopper).toBeUndefined();
    expect(await followDirectPullRequest(ctx, directJob({ pullRequest: closed.url, follow: 'open' }))).toMatchObject({ outcome: 'closed', state: { follow: 'closed' } });
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);
  });

  it('a job that follows nothing: nothing is read', async () => {
    const { gh, ctx } = setup(true);
    expect(await followDirectPullRequest(ctx, directJob({ reported: 'finished' }))).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });
});
