// After done (issue #579): a job that ships part of its issue opens a pull request with "Part of #N" and ends partly
// done; the issue says where the work is — `hopper:pr-ready` while the job's pull request waits for review,
// `hopper:partly-done` while its part waits, `hopper:done` once the issue is closed as complete —; and the hopper follows
// the pull request: merged, the item is done (a part: the next part may be taken); closed without a merge, the item is
// flagged `hopper:pr-closed`.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue() {
  const s = setup();
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('partly done: the job\'s own pull request that ships part of the issue', () => {
  it('open, ready for review, saying "Part of #N": its URL', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    expect(await source.partlyDone!(jobForIssue(1))).toBe(pr.url);
  });

  it('merged already (yolo mode): its URL too', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.mergePullRequest(pr.url);
    expect(await source.partlyDone!(jobForIssue(1))).toBe(pr.url);
  });

  it.each([
    ['a draft', { createdAt: AFTER, isDraft: true }],
    ['one with merge conflicts', { createdAt: AFTER, conflicting: true }],
    ['one opened before the job began', { createdAt: BEFORE }],
  ] as const)('%s is not', async (_n, o) => {
    const { gh, source } = withIssue();
    gh.openPartPullRequest(REPO, 1, o);
    expect(await source.partlyDone!(jobForIssue(1))).toBeUndefined();
  });

  it('closed without a merge, or naming another issue, is not', async () => {
    const { gh, source } = withIssue();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const closed = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.closePullRequest(closed.url);
    gh.openPartPullRequest(REPO, 2, { createdAt: AFTER });
    expect(await source.partlyDone!(jobForIssue(1))).toBeUndefined();
  });
});

describe('the end of a done job on its issue', () => {
  it('its pull request waits for review: hopper:pr-ready, never hopper:done; the pull request is kept to follow', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    expect(state).toEqual({ pullRequest: pr.url, follow: 'open' });
  });

  it('an older pull request that closes the issue, updated by the job (issue #618), is the one kept to follow', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.pushToPullRequest(pr.url, AFTER);
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(state).toEqual({ pullRequest: pr.url, follow: 'open' });
  });

  it('a part: hopper:partly-done, the part\'s pull request kept to follow', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', partlyDone: pr.url }) });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:partly-done']);
    expect(state).toEqual({ pullRequest: pr.url, follow: 'open', part: true });
  });

  it('the issue closed as complete already (merged in yolo mode): hopper:done, nothing to follow', async () => {
    const { gh, source } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: AFTER, mergedAt: AFTER });
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(state).toEqual({});
  });

  it('an issue labelled hopper:pr-ready, hopper:partly-done or hopper:pr-closed is not taken again', async () => {
    const { gh, source } = setup();
    for (const l of ['hopper:pr-ready', 'hopper:partly-done', 'hopper:pr-closed']) gh.createIssue({ repo: REPO, labels: ['hopper', l] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([4]);
  });
});

describe('following the pull request', () => {
  async function ended(o: { part?: boolean } = {}) {
    const s = withIssue();
    const pr = o.part ? s.gh.openPartPullRequest(REPO, 1, { createdAt: AFTER }) : s.gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const base = jobForIssue(1, { status: 'finished', ...(o.part ? { partlyDone: pr.url } : {}) });
    const state = await s.source.report({ kind: 'finished', job: base });
    return { ...s, pr, job: { ...base, sourceState: { source: state } } };
  }

  it('still open: nothing changes', async () => {
    const { gh, source, job } = await ended();
    expect(await source.follow!(job)).toBeUndefined();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('merged: the item is done — hopper:done in place of hopper:pr-ready; following ends', async () => {
    const { gh, source, job, pr } = await ended();
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toEqual({ outcome: 'merged', pullRequest: pr.url, part: false, state: { pullRequest: pr.url, follow: 'merged' } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'closed', labels: ['hopper', 'hopper:done'] });
  });

  it('closed without a merge: the item is flagged hopper:pr-closed; following ends', async () => {
    const { gh, source, job, pr } = await ended();
    gh.closePullRequest(pr.url);
    expect(await source.follow!(job)).toEqual({ outcome: 'closed', pullRequest: pr.url, part: false, state: { pullRequest: pr.url, follow: 'closed' } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper', 'hopper:pr-closed'] });
  });

  it('a part merged: hopper:partly-done comes off, so the next part is taken; the issue stays open', async () => {
    const { gh, source, job, pr } = await ended({ part: true });
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toEqual({ outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('a part closed without a merge: hopper:pr-closed', async () => {
    const { gh, source, job, pr } = await ended({ part: true });
    gh.closePullRequest(pr.url);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'closed', part: true });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('a job with nothing to follow: nothing is asked', async () => {
    const { gh, source } = withIssue();
    gh.calls.length = 0;
    expect(await source.follow!(jobForIssue(1, { status: 'finished', sourceState: { source: {} } }))).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });
});
