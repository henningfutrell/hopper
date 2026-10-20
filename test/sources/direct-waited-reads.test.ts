// Issue #2210: a direct job's wait on a pull request's checks or review is read too. No other source lists a direct job, so
// the direct source reads the pull request with the user's own GitHub connection; unconnected, the read fails and says why.
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountTokens } from '../../src/domain/ports.ts';
import { createDirectPullRequests } from '../../src/sources/compose.ts';
import type { GitHubApi, NumberedPullRequest } from '../../src/sources/github/api.ts';

const PR: NumberedPullRequest = { url: 'https://github.com/octo/tools/pull/8', createdAt: '2026-10-17T09:00:00Z', isDraft: false, conflicting: false, state: 'open', checks: 'passing', headCommittedAt: '2026-10-17T09:30:00Z' };
const api = { pullRequest: async () => PR, pullRequestReviews: async () => [{ state: 'approved', submittedAt: '2026-10-17T10:00:00Z' }] } as unknown as GitHubApi;
const clock = { now: () => new Date('2026-10-17T10:00:00Z') };

function direct(login: string | undefined) {
  const accounts = { account: () => login } as unknown as ConnectedAccountTokens;
  return createDirectPullRequests({ accounts, clock, api, yoloMode: () => false, landingBranch: () => undefined, changeRule: () => ({ kind: 'pull_request' }) as never });
}

describe('a direct job\'s waits on a pull request (issue #2210)', () => {
  it('connected: its checks and its reviews, read with the user\'s connection', async () => {
    expect(await direct('octo').waitedChecks('octo/tools', 8)).toEqual({ url: PR.url, state: 'open', checks: 'passing', headCommittedAt: PR.headCommittedAt });
    expect(await direct('octo').waitedReviews('octo/tools', 8)).toMatchObject({ url: PR.url, state: 'open', reviews: [{ state: 'approved' }] });
  });

  it('unconnected: the read fails and says why', async () => {
    await expect(direct(undefined).waitedChecks('octo/tools', 8)).rejects.toThrow(/GitHub/);
    await expect(direct(undefined).waitedReviews('octo/tools', 8)).rejects.toThrow(/GitHub/);
  });
});
