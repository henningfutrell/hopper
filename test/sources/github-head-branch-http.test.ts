// Head branch deletion's GitHub calls (issue #2914), the real adapter against the node:http fake GitHub: a pull request and a
// branch as a deletion reads them, the delete, and the sweep's listing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountGitHubApi } from '../../src/sources/github/account/api.ts';
import type { GitHubApi } from '../../src/sources/github/index.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';

const REPO = 'owner/repo';
let server: FakeGitHubServer;
let api: GitHubApi;

beforeEach(async () => {
  server = await createFakeGitHubServer({
    login: 'owner', token: 'tok',
    installations: [{ id: 1, account: 'owner', repos: [{
      owner: 'owner', name: 'repo',
      branches: [{ name: 'main', sha: 'm1', protected: true }, { name: 'merged', sha: 'a1' }, { name: 'moved', sha: 'later' }, { name: 'open', sha: 'c1' }, { name: 'ontop', sha: 'd1' }],
      issues: [
        { number: 1, pullRequest: true, state: 'closed', pull: { headRef: 'merged', headOid: 'a1', base: 'main', state: 'MERGED' }, updatedAt: '2026-11-01T00:00:00.000Z' },
        { number: 2, pullRequest: true, state: 'closed', pull: { headRef: 'moved', headOid: 'b1', base: 'main', state: 'CLOSED' }, updatedAt: '2026-11-01T00:00:00.000Z' },
        { number: 3, pullRequest: true, pull: { headRef: 'open', headOid: 'c1', base: 'main' } },
        { number: 4, pullRequest: true, pull: { headRef: 'ontop', headOid: 'd1', base: 'merged' } },
      ],
    }] }],
  });
  api = createAccountGitHubApi({ apiUrl: server.url, token: async () => 'tok' });
});
afterEach(async () => { await server.close(); });

describe('the head branch calls (issue #2914)', () => {
  it('reads a pull request, a merged one with its end, and none for no pull request', async () => {
    expect(await api.headBranchPull!(REPO, 1)).toEqual({ url: 'https://github.com/owner/repo/pull/1', state: 'merged', headRef: 'merged', headOid: 'a1', fork: false, defaultBranch: 'main', endedAt: '2026-11-01T00:00:00.000Z' });
    expect((await api.headBranchPull!(REPO, 3))!.state).toBe('open');
    expect(await api.headBranchPull!(REPO, 99)).toBeUndefined();
  });

  it('reads a branch: its tip, its protection, the open pull requests that need it; none for no branch', async () => {
    expect(await api.branchFacts!(REPO, 'merged')).toEqual({ tip: 'a1', protected: false, openHeads: 0, openBases: 1 });
    expect(await api.branchFacts!(REPO, 'main')).toMatchObject({ tip: 'm1', protected: true });
    expect(await api.branchFacts!(REPO, 'open')).toMatchObject({ openHeads: 1 });
    expect(await api.branchFacts!(REPO, 'gone')).toBeUndefined();
  });

  it('deletes a branch, and a second delete of it does not throw', async () => {
    await api.deleteBranch!(REPO, 'open');
    expect(await api.branchFacts!(REPO, 'open')).toBeUndefined();
    await expect(api.deleteBranch!(REPO, 'open')).resolves.toBeUndefined();
  });

  it('lists each branch with the pull requests whose head it is', async () => {
    const page = await api.branchRefs!(REPO);
    expect(page.defaultBranch).toBe('main');
    expect(page.after).toBeUndefined();
    expect(page.refs.find((r) => r.name === 'moved')).toEqual({ name: 'moved', tip: 'later', pulls: [{ url: 'https://github.com/owner/repo/pull/2', state: 'closed', headOid: 'b1', fork: false, endedAt: '2026-11-01T00:00:00.000Z' }] });
    expect(page.refs.find((r) => r.name === 'main')).toEqual({ name: 'main', tip: 'm1', pulls: [] });
  });
});
