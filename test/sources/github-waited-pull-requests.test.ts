// The pull requests jobs wait on (issue #1433): at each sync the source reads each one a job's own wait names, and says
// which ended — merged, or closed without a merge — so the jobs waiting on them wake, whatever job, if any, follows them.
import { describe, expect, it } from 'vitest';
import { REPO, setup } from './fixtures/github-support.ts';

const AT = '2026-10-02T09:00:00.000Z';
const numberOf = (url: string) => Number(url.slice(url.lastIndexOf('/') + 1));

describe('the ended pull requests of the waits (issue #1433)', () => {
  it('says which pull requests merged or closed without a merge; an open one is not in the answer', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.gh.createIssue({ repo: REPO });
    const open = s.gh.openPullRequest(REPO, 1, { createdAt: AT });
    const closed = s.gh.openPullRequest(REPO, 2, { createdAt: AT });
    const merged = s.gh.openPullRequest(REPO, 3, { createdAt: AT });
    s.gh.closePullRequest(closed.url);
    s.gh.mergePullRequest(merged.url, AT);
    const ended = await s.source.endedPullRequests!([open, closed, merged].map((p) => ({ repo: REPO, number: numberOf(p.url) })));
    expect(ended).toEqual([
      { repo: REPO, number: numberOf(closed.url), pullRequest: closed.url, state: 'closed' },
      { repo: REPO, number: numberOf(merged.url), pullRequest: merged.url, state: 'merged' },
    ]);
  });

  it('a pull request GitHub does not know, or a read that fails, is left out: asked again at the next sync', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO });
    const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AT });
    s.gh.closePullRequest(pr.url);
    s.gh.failNext('pullRequest', new Error('GitHub is down'));
    expect(await s.source.endedPullRequests!([{ repo: REPO, number: numberOf(pr.url) }, { repo: REPO, number: 999 }])).toEqual([]);
    expect(await s.source.endedPullRequests!([{ repo: REPO, number: numberOf(pr.url) }])).toHaveLength(1);
  });
});
