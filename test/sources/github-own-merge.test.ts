// The close after the hopper's own merge (issue #677), made again after a stop (issue #1959): a merge found by its marker
// may have its close and its comment done already. The close is made again, the comment only when the issue lacks it, and
// a pull request whose closing keyword closed the issue is left as it is. In-memory fake GitHub.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { closeAfterMerge, closedAfterMergeComment } from '../../src/sources/github/own-merge.ts';

const REPO = 'owner/hopper-sandbox';
const at = () => new Date().toISOString();

describe('closeAfterMerge (issues #677, #1959)', () => {
  it('again after a stop between the close and its comment: the comment is posted once', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'Please.', labels: ['hopper'] });
    const pr = gh.openReferencingPullRequest(REPO, issue.number, { createdAt: at() });
    gh.mergePullRequest(pr.url);
    // The stop came after the close.
    gh.closeIssue(REPO, issue.number, 'owner');
    expect(await closeAfterMerge(gh, REPO, issue.number, pr.url, true)).toBe(true);
    expect(await closeAfterMerge(gh, REPO, issue.number, pr.url, true)).toBe(true);
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(gh.commentsOn(REPO, issue.number).map((c) => c.body)).toEqual([closedAfterMergeComment(pr.url)]);
  });

  it('again, the pull request closed the issue by its keyword: nothing is closed or posted', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'Please.', labels: ['hopper'] });
    const pr = gh.openPullRequest(REPO, issue.number, { createdAt: at() });
    gh.mergePullRequest(pr.url);
    expect(await closeAfterMerge(gh, REPO, issue.number, pr.url, true)).toBe(false);
    expect(gh.calls.filter((c) => c.method === 'closeAsCompleted' || c.method === 'postComment')).toEqual([]);
  });

  it('the first time: closed and posted, with no read of the comments', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'Please.', labels: ['hopper'] });
    const pr = gh.openReferencingPullRequest(REPO, issue.number, { createdAt: at() });
    gh.mergePullRequest(pr.url);
    expect(await closeAfterMerge(gh, REPO, issue.number, pr.url)).toBe(true);
    expect(gh.commentsOn(REPO, issue.number)).toHaveLength(1);
    expect(gh.calls.filter((c) => c.method === 'listComments')).toEqual([]);
  });
});
