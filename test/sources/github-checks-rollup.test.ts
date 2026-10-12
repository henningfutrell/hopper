// A pull request's checks as GitHub's rollup says them (issue #927): a check that failed counts at once, even while the
// rollup still waits on others (a sharded run whose other shards still run). Else the rollup's own state.
import { describe, expect, it } from 'vitest';
import { pullRequestFrom } from '../../src/sources/github/closer.ts';

const AT = '2026-10-02T11:00:00Z';
const withRollup = (rollup: unknown) => ({ data: { repository: { issueOrPullRequest: {
  __typename: 'PullRequest', url: 'https://github.com/owner/repo/pull/7', createdAt: AT, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { committedDate: AT, statusCheckRollup: rollup } }] },
} } } });
const contexts = (...nodes: unknown[]) => ({ nodes });

describe('the checks of a pull request (issue #927)', () => {
  it('pending, but one check run failed or timed out: failing', () => {
    for (const conclusion of ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']) {
      const r = withRollup({ state: 'PENDING', contexts: contexts({ __typename: 'CheckRun', conclusion: null }, { __typename: 'CheckRun', conclusion }) });
      expect(pullRequestFrom(r, 'pull request')?.checks).toBe('failing');
    }
  });

  it('pending, but one commit status failed: failing', () => {
    const r = withRollup({ state: 'PENDING', contexts: contexts({ __typename: 'StatusContext', state: 'PENDING' }, { __typename: 'StatusContext', state: 'ERROR' }) });
    expect(pullRequestFrom(r, 'pull request')?.checks).toBe('failing');
  });

  it('pending, and nothing failed yet: pending; no contexts read: the rollup\'s state', () => {
    expect(pullRequestFrom(withRollup({ state: 'PENDING', contexts: contexts({ __typename: 'CheckRun', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', conclusion: null }) }), 'pull request')?.checks).toBe('pending');
    expect(pullRequestFrom(withRollup({ state: 'PENDING' }), 'pull request')?.checks).toBe('pending');
    expect(pullRequestFrom(withRollup({ state: 'SUCCESS' }), 'pull request')?.checks).toBe('passing');
  });
});
