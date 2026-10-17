// Issue #1694 part 2: a wait on a pull request's checks is tested on its checks. The GitHub source reads the pull request by
// its number: its state, its checks and its last push; a number that names no pull request is `not_found`.
import { describe, expect, it } from 'vitest';
import { GitHubApiError, type NumberedPullRequest } from '../../src/sources/github/api.ts';
import { waitedChecks } from '../../src/sources/github/watched.ts';

const PR: NumberedPullRequest = { url: 'https://github.com/octo/tools/pull/8', createdAt: '2026-10-17T09:00:00Z', isDraft: false, conflicting: false, state: 'open', checks: 'pending', headCommittedAt: '2026-10-17T09:30:00Z' };

describe('a pull request\'s checks, as the GitHub source reads them (waitedChecks)', () => {
  it('its state, its checks and its last push', async () => {
    expect(await waitedChecks({ pullRequest: async () => PR }, 'octo/tools', 8)).toEqual({ url: PR.url, state: 'open', checks: 'pending', headCommittedAt: '2026-10-17T09:30:00Z' });
    expect(await waitedChecks({ pullRequest: async () => ({ ...PR, state: 'merged', checks: undefined }) }, 'octo/tools', 8)).toEqual({ url: PR.url, state: 'merged', headCommittedAt: '2026-10-17T09:30:00Z' });
  });

  it('a number that is no pull request, or that GitHub does not know: not_found; any other error throws', async () => {
    expect(await waitedChecks({ pullRequest: async () => undefined }, 'octo/tools', 8)).toEqual({ url: 'https://github.com/octo/tools/pull/8', state: 'not_found' });
    expect(await waitedChecks({ pullRequest: async () => { throw new GitHubApiError('Not Found', true, 404); } }, 'octo/tools', 8)).toMatchObject({ state: 'not_found' });
    await expect(waitedChecks({ pullRequest: async () => { throw new GitHubApiError('rate limited', false, 429); } }, 'octo/tools', 8)).rejects.toThrow('rate limited');
  });
});
