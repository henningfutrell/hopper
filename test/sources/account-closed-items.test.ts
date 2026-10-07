// A connected account's source answers closedItems through its GitHub source (issue #362): the sync loop
// asks it which failed jobs' issues are closed, and the live hopper's jobs come from this source. Fake at
// the GitHubApi seam.
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountTokens } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createAccountSource } from '../../src/sources/compose.ts';
import { githubAccountOptions } from '../../src/sources/config.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';

const REPO = 'owner/repo';

function accounts(login: string | undefined): ConnectedAccountTokens {
  return {
    account: () => login, ended: () => undefined, token: async () => 'token', renew: async () => 'token',
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

describe('a connected account\'s source tells which failed jobs\' issues are closed (issue #362)', () => {
  it('closed and open, as its GitHub source reads them', async () => {
    const { gh, s } = source('owner');
    const open = gh.createIssue({ repo: REPO, body: 'x', labels: ['hopper', 'hopper:failed'] });
    const closed = gh.createIssue({ repo: REPO, body: 'x', labels: ['hopper', 'hopper:failed'] });
    gh.closeIssue(REPO, closed.number);
    await s.discover();
    const answers = await s.closedItems!([failedJob('a', open.url, open.number), failedJob('b', closed.url, closed.number)], new Set());
    expect(Object.fromEntries(answers)).toEqual({ a: false, b: true });
  });

  it('not connected, it cannot tell: no answer', async () => {
    const { gh, s } = source(undefined);
    const issue = gh.createIssue({ repo: REPO, body: 'x', labels: ['hopper'] });
    expect((await s.closedItems!([failedJob('a', issue.url, issue.number)], new Set())).size).toBe(0);
  });
});
