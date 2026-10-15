import { afterEach, describe, expect, it } from 'vitest';
import { seen, startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const issue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `T${number}`, labels: ['hopper'], ...extra });

describe('Account adapter: issues and comments', () => {
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

  it('crossReferences reads the closing pull requests and the mentions of an issue over GraphQL (issue #430)', async () => {
    const closing = { url: 'https://github.com/owner/a/pull/9', createdAt: '2026-10-02T10:30:00Z', isDraft: false };
    const mention = (url: string, body: string, repo: string) => ({ url, createdAt: '2026-10-02T10:40:00Z', isDraft: false, state: 'OPEN' as const, body, repo });
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1, {
      openPullRequests: [closing], mentionedBy: [mention(closing.url, 'Fixes #1', 'owner/a'), mention('https://github.com/other/b/pull/3', 'Refs owner/a#1', 'other/b')],
    })] }] }] });
    expect(await h.api.crossReferences('owner/a', 1)).toEqual({
      mentions: [
        { kind: 'pull_request', repo: 'owner/a', url: closing.url, text: 'Fixes #1' },
        { kind: 'pull_request', repo: 'other/b', url: 'https://github.com/other/b/pull/3', text: 'Refs owner/a#1' },
      ],
      closing: [{ kind: 'pull_request', repo: 'owner/a', url: closing.url }],
    });
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

describe('Account adapter: a repository the token cannot reach', () => {
  it('is a permanent 404: the hopper\'s app is not installed there', async () => {
    h = await startApp({ installations: [{ id: 33, account: 'owner', repos: [{ owner: 'owner', name: 'a' }] }] });
    await expect(h.api.getIssue('owner/zzz', 1)).rejects.toMatchObject({ permanent: true, status: 404 });
  });
});
