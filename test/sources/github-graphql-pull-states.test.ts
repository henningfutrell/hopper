// The in-motion cycle's batched reads (issue #985): one GraphQL request reads up to PULLS_MAX followed pull requests and
// their issues, each an alias in it; one reads the open pull requests of up to OPEN_PULLS_REPOS_MAX repositories, for
// reconciling. A pull request or a repository GitHub does not answer for fails only itself. Against the node:http fake
// GitHub, through the App adapter's port.
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PULLS_REPOS_MAX, PULLS_MAX } from '../../src/sources/github/http/graphql-pulls.ts';
import { pullKey } from '../../src/sources/github/api.ts';
import type { FakeIssueInput, FakeRepoInput } from '../../src/sources/github/http/fake-state.ts';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const graphqlRequests = (a: AppHarness) => a.fake.state.requests.filter((r) => r.path === '/graphql');
const restReads = (a: AppHarness) => a.fake.state.requests.filter((r) => r.method === 'GET' && /\/(issues|pulls)\b/.test(r.path));
const repo = (name: string, issues: FakeIssueInput[], owner = 'owner'): FakeRepoInput => ({ owner, name, issues });
const pull = (number: number, body: string, pull: NonNullable<FakeIssueInput['pull']>, over: Partial<FakeIssueInput> = {}): FakeIssueInput =>
  ({ number, body, pullRequest: true, pull, ...over });

describe('pull request states in one batched read (issue #985)', () => {
  it('reads three pull requests and their issues, of two repositories, in one request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [
      repo('a', [
        { number: 1, labels: ['hopper'] },
        pull(2, 'Closes #1', { headRef: 'issue-1', headOid: 'abc', base: 'dev', mergeable: 'MERGEABLE', checks: 'PENDING', createdAt: '2026-10-01T10:00:00Z', committedAt: '2026-10-01T11:00:00Z' }),
        { number: 3, labels: ['hopper'], state: 'closed', stateReason: 'not_planned' },
        pull(4, 'Part of #3', { headRef: 'issue-3', base: 'dev', mergeable: 'CONFLICTING', checks: 'FAILURE', isDraft: true }),
      ]),
      repo('b', [{ number: 1 }, pull(5, 'Closes #1', { state: 'MERGED', mergeable: 'UNKNOWN' }, { state: 'closed' })]),
    ] }] });
    const got = await h.api.pullRequestStates([
      { repo: 'owner/a', pullRequest: 2, issue: 1 }, { repo: 'owner/a', pullRequest: 4, issue: 3 }, { repo: 'owner/b', pullRequest: 5, issue: 1 },
    ]);
    expect(got.errors.size).toBe(0);
    expect(got.pulls.get(pullKey('owner/a', 2))).toMatchObject({
      state: 'open', isDraft: false, mergeable: 'MERGEABLE', checks: 'pending', headRef: 'issue-1', headOid: 'abc', base: 'dev', body: 'Closes #1',
      createdAt: '2026-10-01T10:00:00Z', headCommittedAt: '2026-10-01T11:00:00Z', issue: { state: 'open' },
    });
    expect(got.pulls.get(pullKey('owner/a', 4))).toMatchObject({
      state: 'open', isDraft: true, mergeable: 'CONFLICTING', checks: 'failing', body: 'Part of #3', issue: { state: 'closed', stateReason: 'not_planned' },
    });
    expect(got.pulls.get(pullKey('owner/b', 5))).toMatchObject({ state: 'merged', issue: { state: 'open' } });
    expect(got.pulls.get(pullKey('owner/b', 5))!.checks).toBeUndefined();
    expect(graphqlRequests(h)).toHaveLength(1);
    expect(restReads(h)).toEqual([]);
  });

  it(`${PULLS_MAX * 2 + 1} pull requests are three requests`, async () => {
    const n = PULLS_MAX * 2 + 1;
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [
      repo('a', Array.from({ length: n }, (_, i) => pull(i + 1, '', { mergeable: 'MERGEABLE' }))),
    ] }] });
    const got = await h.api.pullRequestStates(Array.from({ length: n }, (_, i) => ({ repo: 'owner/a', pullRequest: i + 1, issue: i + 1 })));
    expect(got.pulls.size).toBe(n);
    expect(graphqlRequests(h)).toHaveLength(3);
  });

  it('a pull request GitHub does not know, or a repository the connected account cannot reach, fails only itself', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [{ number: 1 }, pull(2, 'Closes #1', {})])] }] });
    const got = await h.api.pullRequestStates([
      { repo: 'owner/a', pullRequest: 2, issue: 1 }, { repo: 'owner/a', pullRequest: 9, issue: 1 }, { repo: 'owner/gone', pullRequest: 1, issue: 1 },
    ]);
    expect(got.pulls.get(pullKey('owner/a', 2))).toMatchObject({ state: 'open' });
    expect(got.pulls.has(pullKey('owner/a', 9))).toBe(false);
    expect(got.errors.get(pullKey('owner/a', 9))).toMatch(/Could not resolve/);
    expect(got.errors.get(pullKey('owner/gone', 1))).toMatch(/Could not resolve to a Repository/);
  });

  it('a request GitHub fails throws: the cycle asks again', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [{ number: 1 }, pull(2, '', {})])] }] });
    await h.api.pullRequestStates([{ repo: 'owner/a', pullRequest: 2, issue: 1 }]);
    h.fake.fail('POST /graphql', 502, 'bad gateway', 1);
    await expect(h.api.pullRequestStates([{ repo: 'owner/a', pullRequest: 2, issue: 1 }])).rejects.toMatchObject({ permanent: false });
  });

  it('none asked is no request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [])] }] });
    expect((await h.api.pullRequestStates([])).pulls.size).toBe(0);
    expect(graphqlRequests(h)).toHaveLength(0);
  });
});

describe('open pull requests of many repositories in one batched read (issue #985: reconciling)', () => {
  it('reads the open pull requests of two repositories, labelled or not, newest first, in one request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [
      repo('a', [
        pull(1, 'Closes #9', { headRef: 'issue-9', createdAt: '2026-10-01T10:00:00Z' }),
        pull(2, 'Part of #9', { headRef: 'x', createdAt: '2026-10-02T10:00:00Z' }, { labels: ['bug'] }),
        pull(3, 'Closes #8', { state: 'MERGED' }, { state: 'closed' }),
        { number: 9 },
      ]),
      repo('b', []),
    ] }] });
    const got = await h.api.openPullRequestsIn(['owner/a', 'owner/b']);
    expect(got.repoErrors.size).toBe(0);
    expect(got.repos.get('owner/a')!.map((p) => [p.url, p.headRef, p.body])).toEqual([
      ['https://github.com/owner/a/pull/2', 'x', 'Part of #9'], ['https://github.com/owner/a/pull/1', 'issue-9', 'Closes #9'],
    ]);
    // Its base and title too (issue #1176: the untracked pull requests list).
    expect(got.repos.get('owner/a')![0]).toMatchObject({ base: 'main', title: 'Issue 2' });
    expect(got.repos.get('owner/b')).toEqual([]);
    expect(graphqlRequests(h)).toHaveLength(1);
    expect(restReads(h)).toEqual([]);
  });

  it(`${OPEN_PULLS_REPOS_MAX + 1} repositories are two requests; one GitHub does not resolve fails only itself`, async () => {
    const names = Array.from({ length: OPEN_PULLS_REPOS_MAX + 1 }, (_, i) => `r${i}`);
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: names.map((n) => repo(n, [pull(1, '', {})])) }] });
    const got = await h.api.openPullRequestsIn([...names.map((n) => `owner/${n}`), 'owner/gone']);
    expect(got.repos.size).toBe(names.length);
    expect(got.repoErrors.get('owner/gone')).toMatch(/Could not resolve to a Repository/);
    expect(graphqlRequests(h)).toHaveLength(2);
  });
});
