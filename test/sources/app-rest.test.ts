import { afterEach, describe, expect, it } from 'vitest';
import { seen, startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const issue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `T${number}`, labels: ['hopper'], ...extra });

describe('App adapter: installations are the allowlist', () => {
  it('lists installed repos across two installations, following pagination', async () => {
    h = await startApp({
      pageSize: 2,
      installations: [
        { id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a' }, { owner: 'owner', name: 'b' }, { owner: 'owner', name: 'c' }] },
        { id: 22, account: 'acme', accountType: 'Organization', repos: [{ owner: 'acme', name: 'x' }] },
      ],
    });
    const repos = await h.api.listInstalledRepos!();
    expect(repos).toEqual([
      { repo: 'owner/a', installationId: 11 }, { repo: 'owner/b', installationId: 11 },
      { repo: 'owner/c', installationId: 11 }, { repo: 'acme/x', installationId: 22 },
    ]);
    expect(seen(h.fake).filter((r) => r === 'GET /installation/repositories')).toHaveLength(3);
    expect(h.fake.state.requests.find((r) => r.path === '/app/installations')?.auth).toBe('jwt');
  });
});

describe('App adapter: issues and comments', () => {
  it('lists open labelled issues, all pages, skipping pull requests', async () => {
    h = await startApp({
      pageSize: 2,
      installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
        issue(1), issue(2, { pullRequest: true }), issue(3, { labels: ['other'] }), issue(4), issue(5, { state: 'closed' }), issue(6),
      ] }] }],
    });
    const issues = await h.api.listOpenIssues('owner/a', 'hopper');
    expect(issues.map((i) => i.number)).toEqual([1, 4, 6]);
    expect(issues[0]).toMatchObject({
      repo: 'owner/a', url: 'https://github.com/owner/a/issues/1', title: 'T1', author: 'owner',
      labels: ['hopper'], state: 'open',
    });
    const listed = h.fake.state.requests.filter((r) => r.path === '/repos/owner/a/issues');
    expect(listed[0]!.query).toMatchObject({ labels: 'hopper', state: 'open' });
    expect(listed.every((r) => r.auth === 'token')).toBe(true);
  });

  it('getIssue reads one issue, closed ones included', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(7, { state: 'closed', closedBy: 'owner', closedAt: '2026-10-02T11:00:00Z', stateReason: 'completed', body: 'b' })] }] }] });
    expect(await h.api.getIssue('owner/a', 7)).toMatchObject({
      number: 7, state: 'closed', closedBy: 'owner', closedAt: '2026-10-02T11:00:00Z', stateReason: 'completed', body: 'b',
    });
    await expect(h.api.getIssue('owner/a', 99)).rejects.toMatchObject({ permanent: true, status: 404 });
  });

  it('closingPullRequest reads the pull request whose merge closed the issue over GraphQL; none for a person', async () => {
    const pr = { url: 'https://github.com/owner/a/pull/9', createdAt: '2026-10-02T10:30:00Z', mergedAt: '2026-10-02T11:00:00Z' };
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      issue(1, { state: 'closed', closedByPullRequest: pr }), issue(2, { state: 'closed', closedBy: 'owner' }),
    ] }] }] });
    expect(await h.api.closingPullRequest('owner/a', 1)).toEqual(pr);
    expect(await h.api.closingPullRequest('owner/a', 2)).toBeUndefined();
    const asked = h.fake.state.requests.filter((r) => r.path === '/graphql');
    expect(asked.every((r) => r.auth === 'token')).toBe(true);
  });

  it('openClosingPullRequests reads the open pull requests that close the issue on merge over GraphQL, and whether each has merge conflicts (issues #187, #579)', async () => {
    const pr = { url: 'https://github.com/owner/a/pull/9', createdAt: '2026-10-02T10:30:00Z', isDraft: false };
    const conflicted = { url: 'https://github.com/owner/a/pull/10', createdAt: '2026-10-02T10:40:00Z', isDraft: false, mergeable: 'CONFLICTING' };
    const unknown = { url: 'https://github.com/owner/a/pull/11', createdAt: '2026-10-02T10:50:00Z', isDraft: false, mergeable: 'UNKNOWN' };
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      issue(1, { openPullRequests: [pr, conflicted, unknown] }), issue(2),
    ] }] }] });
    expect(await h.api.openClosingPullRequests('owner/a', 1)).toEqual([
      { ...pr, conflicting: false },
      { url: conflicted.url, createdAt: conflicted.createdAt, isDraft: false, conflicting: true },
      { url: unknown.url, createdAt: unknown.createdAt, isDraft: false, conflicting: false },
    ]);
    expect(await h.api.openClosingPullRequests('owner/a', 2)).toEqual([]);
    const asked = h.fake.state.requests.filter((r) => r.path === '/graphql');
    expect(asked.every((r) => r.auth === 'token')).toBe(true);
  });

  it('referencingPullRequests reads the pull requests that mention the issue, any state, over GraphQL (issue #579)', async () => {
    const part = { url: 'https://github.com/owner/a/pull/9', createdAt: '2026-10-02T10:30:00Z', isDraft: false, state: 'OPEN' as const, body: 'Part of #1', repo: 'owner/a' };
    const merged = { url: 'https://github.com/owner/a/pull/10', createdAt: '2026-10-02T10:40:00Z', isDraft: false, state: 'MERGED' as const, body: 'Closes #1', repo: 'owner/a', mergeable: 'UNKNOWN' };
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1, { mentionedBy: [part, merged] }), issue(2)] }] }] });
    expect(await h.api.referencingPullRequests('owner/a', 1)).toEqual([
      { url: part.url, createdAt: part.createdAt, isDraft: false, conflicting: false, state: 'open', body: 'Part of #1', repo: 'owner/a' },
      { url: merged.url, createdAt: merged.createdAt, isDraft: false, conflicting: false, state: 'merged', body: 'Closes #1', repo: 'owner/a' },
    ]);
    expect(await h.api.referencingPullRequests('owner/a', 2)).toEqual([]);
  });

  it('pullRequest reads a pull request by its number over GraphQL, with when its head commit was made; an issue or nothing is undefined (issue #618)', async () => {
    const open = { url: 'https://github.com/owner/a/pull/9', createdAt: '2026-10-02T10:30:00Z', isDraft: false, mergeable: 'MERGEABLE', headCommittedAt: '2026-10-03T08:00:00Z' };
    const merged = {
      url: 'https://github.com/owner/a/pull/10', createdAt: '2026-10-02T10:40:00Z', isDraft: false, state: 'MERGED' as const, body: 'Closes #2', repo: 'owner/a',
      mergedAt: '2026-10-03T09:00:00Z', headCommittedAt: '2026-10-03T08:30:00Z',
    };
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      issue(1, { openPullRequests: [open] }), issue(2, { mentionedBy: [merged] }),
    ] }] }] });
    expect(await h.api.pullRequest('owner/a', 9)).toEqual({
      url: open.url, createdAt: open.createdAt, isDraft: false, conflicting: false, state: 'open', headCommittedAt: open.headCommittedAt,
    });
    expect(await h.api.pullRequest('owner/a', 10)).toEqual({
      url: merged.url, createdAt: merged.createdAt, isDraft: false, conflicting: false, state: 'merged', mergedAt: merged.mergedAt, headCommittedAt: merged.headCommittedAt,
    });
    expect(await h.api.pullRequest('owner/a', 1)).toBeUndefined();
    expect(await h.api.pullRequest('owner/a', 77)).toBeUndefined();
  });

  it('lists every comment oldest first across pages', async () => {
    const comments = [1, 2, 3, 4, 5].map((n) => ({ author: 'owner', body: `c${n}` }));
    h = await startApp({ pageSize: 2, installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1, { comments })] }] }] });
    const listed = await h.api.listComments('owner/a', 1);
    expect(listed.map((c) => c.body)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(listed.map((c) => c.id)).toEqual([...listed.map((c) => c.id)].sort((a, b) => a - b));

  });

  it('labels: create (422 already_exists is fine), add, remove (absent label is fine)', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', labels: ['hopper'], issues: [issue(1)] }] }] });
    await h.api.ensureLabel('owner/a', 'hopper:claimed', 'fbca04', 'claimed');
    await h.api.ensureLabel('owner/a', 'hopper:claimed', 'fbca04', 'claimed');
    expect(seen(h.fake).filter((r) => r === 'POST /repos/owner/a/labels')).toHaveLength(2);
    await h.api.addLabels('owner/a', 1, ['hopper:claimed']);
    expect(h.fake.state.repos.get('owner/a')!.issues.get(1)!.labels).toEqual(['hopper', 'hopper:claimed']);
    await h.api.removeLabels('owner/a', 1, ['hopper:claimed', 'never-there']);
    expect(h.fake.state.repos.get('owner/a')!.issues.get(1)!.labels).toEqual(['hopper']);
  });
});

describe('App adapter: cold installation lookup', () => {
  it('a report before any listInstalledRepos looks the installation up per repo (JWT), once', async () => {
    h = await startApp({ installations: [{ id: 33, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1)] }] }] });
    await h.api.addLabels('owner/a', 1, ['cold']);
    await h.api.getIssue('owner/a', 1);
    const lookups = h.fake.state.requests.filter((r) => r.path === '/repos/owner/a/installation');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.auth).toBe('jwt');
    expect(seen(h.fake)).not.toContain('GET /app/installations');
  });

  it('a repo the app is not installed on is a permanent "app not installed"', async () => {
    h = await startApp({ installations: [{ id: 33, account: 'owner', repos: [{ owner: 'owner', name: 'a' }] }] });
    await expect(h.api.getIssue('owner/zzz', 1)).rejects.toMatchObject({
      permanent: true, message: expect.stringMatching(/app not installed on owner\/zzz/),
    });
  });
});
