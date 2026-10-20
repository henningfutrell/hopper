// A GitHub App without Checks and Commit statuses read (issue #855): GitHub answers a pull request query with the data and a
// FORBIDDEN error on each head commit's `statusCheckRollup`. The answer is kept, each pull request's checks are unknown, and
// any other error still throws.
import { describe, expect, it } from 'vitest';
import { openPullRequestsFrom, pullRequestFrom, referencingPullRequestsFrom, repoPullRequestsFrom } from '../../src/sources/github/closer.ts';

const URL = 'https://github.com/owner/repo/pull/7';
const AT = '2026-10-02T11:00:00Z';
const pr = { url: URL, createdAt: AT, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', commits: { nodes: [{ commit: { committedDate: AT, statusCheckRollup: null } }] } };
const forbidden = (path: (string | number)[]) => ({
  type: 'FORBIDDEN', path: [...path, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'], message: 'Resource not accessible by integration',
});

describe('a pull request query whose checks the app may not read (issue #855)', () => {
  it('the open pull requests of a repository: kept, checks unknown', () => {
    const body = { data: { repository: { pullRequests: { nodes: [{ ...pr, headRefName: 'issue-1', body: 'Closes #1' }] } } }, errors: [forbidden(['repository', 'pullRequests', 'nodes', 0])] };
    expect(repoPullRequestsFrom(body, 'open pull requests')).toEqual([
      { url: URL, createdAt: AT, isDraft: false, conflicting: false, headRef: 'issue-1', body: 'Closes #1', headCommittedAt: AT, checks: 'unknown' },
    ]);
  });

  it('the pull requests that mention an issue: kept, checks unknown', () => {
    const source = { __typename: 'PullRequest', ...pr, mergedAt: null, body: 'Part of #1', repository: { nameWithOwner: 'owner/repo' } };
    const body = { data: { repository: { issue: { timelineItems: { nodes: [{ source }] } } } }, errors: [forbidden(['repository', 'issue', 'timelineItems', 'nodes', 0, 'source'])] };
    expect(referencingPullRequestsFrom(body, 'mentions')).toMatchObject([{ url: URL, state: 'open', checks: 'unknown' }]);
  });

  it('the open pull requests that close an issue, and a pull request by its number: kept, checks unknown', () => {
    const closing = { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [pr] } } } }, errors: [forbidden(['repository', 'issue', 'closedByPullRequestsReferences', 'nodes', 0])] };
    expect(openPullRequestsFrom(closing, 'closing')).toMatchObject([{ url: URL, checks: 'unknown' }]);
    const numbered = { data: { repository: { issueOrPullRequest: { __typename: 'PullRequest', ...pr, baseRefName: 'dev', headRefName: 'issue-1' } } }, errors: [forbidden(['repository', 'issueOrPullRequest'])] };
    expect(pullRequestFrom(numbered, 'pull request')).toMatchObject({ url: URL, base: 'dev', headRef: 'issue-1', checks: 'unknown' });
  });

  it('checks the app may read: as GitHub says them; no rollup and no error: no checks', () => {
    const passing = { ...pr, commits: { nodes: [{ commit: { committedDate: AT, statusCheckRollup: { state: 'SUCCESS' } } }] } };
    expect(openPullRequestsFrom({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [passing, { ...pr, url: `${URL}8` }] } } } } }, 'closing'))
      .toMatchObject([{ checks: 'passing' }, { url: `${URL}8` }]);
    expect(openPullRequestsFrom({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [pr] } } } } }, 'closing')[0]).not.toHaveProperty('checks');
  });

  it('a FORBIDDEN error inside the rollup (a check run\'s annotations): the read holds, checks as the rollup says (issue #2210)', () => {
    const rollup = { state: 'SUCCESS', contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', databaseId: 1, name: 'plan', status: 'COMPLETED', conclusion: 'SUCCESS', annotations: null }] } };
    const passing = { ...pr, commits: { nodes: [{ commit: { committedDate: AT, statusCheckRollup: rollup } }] } };
    const path = ['repository', 'issueOrPullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'contexts', 'nodes', 0, 'annotations'];
    const body = { data: { repository: { issueOrPullRequest: { __typename: 'PullRequest', ...passing } } }, errors: [{ type: 'FORBIDDEN', path, message: 'Resource not accessible by integration' }] };
    expect(pullRequestFrom(body, 'pull request')).toMatchObject({ url: URL, state: 'open', checks: 'passing' });
  });

  it('any other FORBIDDEN error still throws, permanent', () => {
    const body = { data: { repository: null }, errors: [{ type: 'FORBIDDEN', path: ['repository'], message: 'Resource not accessible by integration' }] };
    expect(() => repoPullRequestsFrom(body, 'open pull requests of owner/repo')).toThrow(/open pull requests of owner\/repo: Resource not accessible by integration/);
  });
});
