// A job's own part merged before its end was reported (issue #1231): the job was judged done, so the report named no pull
// request. The follow names that part and ends it as a merged part, so the next part is taken. So does a pull request that
// only mentions the issue, with no "Part of #N", merged since the job began (issue #1891): the follow no longer waits for ever.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

function withIssue() {
  const s = setup();
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('a part merged before the report (issue #1231)', () => {
  it('the job\'s own part merged before the report (issue #1231): a merged part, so the next part is taken', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: AFTER });
    gh.mergePullRequest(pr.url, AFTER);
    const base = jobForIssue(1, { status: 'finished' });
    // The job ended done, not partly done: the report names no pull request and adds hopper:pr-ready.
    const state = await source.report({ kind: 'finished', job: base });
    expect(state).toEqual({ follow: 'open' });
    const up = await source.follow!({ ...base, sourceState: { source: state } });
    expect(up).toMatchObject({ outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('a pull request of several issues that only mentions the issue, merged after the job began (issue #1891): a merged part', async () => {
    const { gh, source } = withIssue();
    const base = jobForIssue(1, { status: 'finished' });
    // The job ended with no pull request: the report names none, and puts no hopper:blocked on (issue #2693).
    const state = await source.report({ kind: 'finished', job: base });
    expect(state).toEqual({ follow: 'open' });
    expect(gh.issue(REPO, 1).labels).not.toContain('hopper:blocked');
    const pr = gh.openReferencingPullRequest(REPO, 1, { createdAt: AFTER, body: 'Fixes the parser. Closes #7. Refs #1.' });
    gh.mergePullRequest(pr.url, AFTER);
    const up = await source.follow!({ ...base, sourceState: { source: state } });
    expect(up).toMatchObject({ outcome: 'merged', pullRequest: pr.url, part: true, state: { pullRequest: pr.url, follow: 'merged', part: true, mention: true } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('a part merged before the job began is not its own: nothing changes', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPartPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.mergePullRequest(pr.url, BEFORE);
    expect(await source.follow!(jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open' } } }))).toBeUndefined();
  });
});

describe('a mention merged before the job began (issue #1891)', () => {
  it('is not the job\'s: the follow still waits', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openReferencingPullRequest(REPO, 1, { createdAt: BEFORE });
    gh.mergePullRequest(pr.url, BEFORE);
    expect(await source.follow!(jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open' } } }))).toBeUndefined();
  });
});
