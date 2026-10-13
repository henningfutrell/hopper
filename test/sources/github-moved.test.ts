// Issue #967: between syncs the GitHub source says whether a repository moved, from its event feed (`repoEvents`): a pull
// request opened, closed or merged, or a push, since it was asked last. The first ask of a repository only learns where it
// stands. Other events (a comment, a star) are no move.
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, setup } from './fixtures/github-support.ts';

const AT = '2026-10-02T11:00:00.000Z';
const OTHER = 'acme/other';

describe('moved: the repository event feed', () => {
  it('the first ask learns where each repository stands; a pull request opened after it is a move, once', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.openClosingPullRequest(REPO, 1, { createdAt: AT });
    expect(await source.moved!([REPO])).toBe(false);
    expect(await source.moved!([REPO])).toBe(false);
    gh.openClosingPullRequest(REPO, 1, { createdAt: AT });
    expect(await source.moved!([REPO])).toBe(true);
    expect(await source.moved!([REPO])).toBe(false);
  });

  it('a merge, a close without a merge and a push are moves', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const a = gh.openClosingPullRequest(REPO, 1, { createdAt: AT });
    const b = gh.openClosingPullRequest(REPO, 1, { createdAt: AT });
    await source.moved!([REPO]);
    gh.mergePullRequest(a.url);
    expect(await source.moved!([REPO])).toBe(true);
    gh.closePullRequest(b.url);
    expect(await source.moved!([REPO])).toBe(true);
    gh.pushTo(REPO, 'dev');
    expect(await source.moved!([REPO])).toBe(true);
  });

  it('another kind of event is no move', async () => {
    const { gh, source } = setup();
    await source.moved!([REPO]);
    gh.feedEvent(REPO, 'WatchEvent');
    gh.feedEvent(REPO, 'IssueCommentEvent');
    expect(await source.moved!([REPO])).toBe(false);
  });

  it('a move in any repository asked is a move; a failed read of one does not hide a move in another', async () => {
    const { gh, source } = setup();
    await source.moved!([REPO, OTHER]);
    gh.pushTo(OTHER, 'main');
    gh.failNext('repoEvents', new GitHubApiError('boom', false, 502));
    expect(await source.moved!([REPO, OTHER])).toBe(true);
  });

  it('a failed read with no move elsewhere throws', async () => {
    const { gh, source } = setup();
    await source.moved!([REPO]);
    gh.failNext('repoEvents', new GitHubApiError('boom', false, 502));
    await expect(source.moved!([REPO])).rejects.toThrow('boom');
  });
});
