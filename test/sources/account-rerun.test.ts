// A connected account's source runs an item again through its GitHub source (issue #354): Run again asks
// it for the item back, and the live hopper's jobs come from this source. Fake at the GitHubApi seam.
import { describe, expect, it } from 'vitest';
import { SourceError, type ConnectedAccountTokens } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createAccountSource } from '../../src/sources/compose.ts';
import { githubAccountOptions } from '../../src/sources/config.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';

const REPO = 'owner/repo';

function accounts(login: string | undefined): ConnectedAccountTokens {
  return {
    account: () => login, ended: () => undefined, expired: () => false, token: async () => 'token', renew: async () => 'token',
    endpoints: () => ({ url: 'https://github.com', apiUrl: 'https://api.github.com' }), jobRepositories: () => [REPO],
  };
}

const failedJob = (id: string, url: string, number: number): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'failed', approved: false, attempts: 1,
  createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z',
  source: { source: 'github-account', kind: 'github-account', key: url, url, repo: REPO, number },
} as Job);

function source(login: string | undefined) {
  const gh = createFakeGitHub();
  const s = createAccountSource({
    name: 'github-account', provider: 'github', accounts: accounts(login), api: gh,
    clock: { now: () => new Date('2026-10-07T12:00:00Z') }, knownKeys: () => new Set(), rerunnable: () => new Set(), env: () => undefined,
  }, githubAccountOptions.parse({}));
  return { gh, s };
}

describe('a connected account\'s source runs an item again (issue #354)', () => {
  it('gives a closed issue back reopened, its end labels gone, as an item for the new job', async () => {
    const { gh, s } = source('owner');
    const issue = gh.createIssue({ repo: REPO, body: 'x', labels: ['hopper', 'hopper:failed'] });
    gh.closeIssue(REPO, issue.number);
    const item = await s.rerun!(failedJob('a', issue.url, issue.number));
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect(item).toMatchObject({ key: issue.url, repo: REPO, number: issue.number });
  });

  it('not connected, it cannot: a SourceError, and the issue is left as it is', async () => {
    const { gh, s } = source(undefined);
    const issue = gh.createIssue({ repo: REPO, body: 'x', labels: ['hopper', 'hopper:failed'] });
    const err = await s.rerun!(failedJob('a', issue.url, issue.number)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(gh.issue(REPO, issue.number).labels).toEqual(['hopper', 'hopper:failed']);
  });
});
