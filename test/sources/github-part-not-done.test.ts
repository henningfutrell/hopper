// A part never marks the issue done (issue #721). A pull request that says "Part of #N" ships a part, wherever it is
// found — a cross-reference, or a branch named for the issue. `hopper:done` goes on only when a merged pull request
// closes the issue: the issue is closed as completed, or the pull request's body closes it with a closing keyword.
// A merge recorded as the whole issue before this rule is checked once: one that did not close the issue was a part,
// so `hopper:done` comes off and the issue is offered again.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue() {
  const s = setup();
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('a part on a branch named for the issue', () => {
  it('is not the whole issue done: the job ends partly done', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headRef: 'issue-1-first-part' });
    const job = jobForIssue(1);
    expect(await source.notComplete!(job)).toBeDefined();
    expect(await source.partlyDone!(job)).toBe(pr.url);
  });

  it('is never the pull request a whole issue\'s report follows', async () => {
    const { gh, source } = withIssue();
    gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headRef: 'issue-1-first-part' });
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished' }) });
    expect(state).toEqual({ follow: 'open' });
  });
});

describe('a merge marks the issue done only when it closes the issue', () => {
  async function followed(open: (gh: ReturnType<typeof setup>['gh']) => { url: string }) {
    const s = withIssue();
    const pr = open(s.gh);
    s.gh.addLabel(REPO, 1, 'hopper:pr-ready');
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'open' } } });
    return { ...s, pr, job };
  }

  it('a part followed as the whole issue, merged: a part — no hopper:done, the issue is offered again', async () => {
    const { gh, source, job, pr } = await followed((gh) => gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headRef: 'issue-1-first-part' }));
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toEqual({ outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('a pull request that only mentions the issue ("Refs #N"), merged, the issue still open: a part, not done', async () => {
    const { gh, source, job, pr } = await followed((gh) => gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER }));
    gh.mergePullRequest(pr.url);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', part: true });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('a pull request that closes the issue, merged: done, and its merge is not checked again', async () => {
    const { gh, source, job, pr } = await followed((gh) => gh.openPullRequest(REPO, 1, { createdAt: AFTER }));
    gh.mergePullRequest(pr.url);
    const up = await source.follow!(job);
    expect(up).toEqual({ outcome: 'merged', pullRequest: pr.url, part: false, state: { pullRequest: pr.url, follow: 'merged', mergeChecked: true } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    gh.calls.length = 0;
    expect(await source.follow!({ ...job, sourceState: { source: up!.state } })).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });
});

describe('a merge recorded as the whole issue before issue #721, checked once', () => {
  function recorded(open: (gh: ReturnType<typeof setup>['gh']) => { url: string }) {
    const s = withIssue();
    const pr = open(s.gh);
    s.gh.mergePullRequest(pr.url);
    s.gh.addLabel(REPO, 1, 'hopper:done');
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'merged' } } });
    return { ...s, pr, job };
  }

  it('a part, the issue still open: hopper:done comes off, the issue is offered again, recorded as a part', async () => {
    const { gh, source, job, pr } = recorded((gh) => gh.openPartPullRequest(REPO, 1, { createdAt: AFTER, headRef: 'issue-1-first-part' }));
    expect((await source.discover()).map((i) => i.number)).toEqual([]);
    expect(await source.follow!(job)).toEqual({ outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('one that closed the issue: nothing changes on the issue; the merge is marked checked', async () => {
    const { gh, source, job, pr } = recorded((gh) => gh.openPullRequest(REPO, 1, { createdAt: AFTER }));
    expect(await source.follow!(job)).toEqual({ outcome: 'checked', pullRequest: pr.url, part: false, state: { pullRequest: pr.url, follow: 'merged', mergeChecked: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'closed', labels: ['hopper', 'hopper:done'] });
  });

  it('a recorded part, or a merge checked already: nothing is asked', async () => {
    const { gh, source, pr } = recorded((gh) => gh.openPartPullRequest(REPO, 1, { createdAt: AFTER }));
    gh.calls.length = 0;
    for (const extra of [{ part: true }, { mergeChecked: true }]) {
      const job = jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: pr.url, follow: 'merged', ...extra } } });
      expect(await source.follow!(job)).toBeUndefined();
    }
    expect(gh.calls).toEqual([]);
  });
});
