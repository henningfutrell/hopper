// Repository listings (issue #985): one GraphQL request lists the open labelled issues and pull requests of up to
// LISTING_REPOS_MAX repositories, each an alias in it, paged only for a repository with more. A repository GitHub does not
// answer for fails only itself. Against the node:http fake GitHub, through the App adapter's port.
import { afterEach, describe, expect, it } from 'vitest';
import { LISTING_REPOS_MAX, listRepos } from '../../src/sources/github/app/graphql-listing.ts';
import { makeRequest } from '../../src/sources/github/app/http.ts';
import type { FakeIssueInput, FakeRepoInput } from '../../src/sources/github/app/fake-state.ts';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const LABELS = ['hopper', 'hopper:high'];
const graphqlRequests = (a: AppHarness) => a.fake.state.requests.filter((r) => r.path === '/graphql');
const restListings = (a: AppHarness) => a.fake.state.requests.filter((r) => /\/issues$/.test(r.path) && r.method === 'GET');
const repo = (name: string, issues: FakeIssueInput[], owner = 'owner'): FakeRepoInput => ({ owner, name, issues });
const numbers = (items: { number: number }[] | undefined) => (items ?? []).map((i) => i.number).sort((a, b) => a - b);

describe('repository listings (issue #985)', () => {
  it('lists the open issues and pull requests that carry one of the labels, of three repositories, in one request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [
      repo('a', [
        { number: 1, title: 'One', labels: ['hopper'], assignees: ['dev'], author: 'dev' },
        { number: 2, labels: ['hopper:high', 'bug'] },
        { number: 3, labels: ['bug'] },
        { number: 4, labels: ['hopper'], state: 'closed' },
        { number: 5, labels: ['hopper'], pullRequest: true, pull: { headRef: 'issue-1', headOid: 'abc', base: 'dev', isDraft: false, mergeable: 'MERGEABLE', checks: 'PENDING' } },
        { number: 6, labels: ['hopper'], pullRequest: true, pull: { headRef: 'issue-2', headOid: 'def', base: 'dev', isDraft: true } },
      ]),
      repo('b', [{ number: 1, labels: ['hopper'] }]),
      repo('c', []),
    ] }] });
    const got = await h.api.listRepos!(['owner/a', 'owner/b', 'owner/c'], LABELS);
    expect(got.repoErrors.size).toBe(0);
    expect(numbers(got.repos.get('owner/a'))).toEqual([1, 2, 5, 6]);
    expect(numbers(got.repos.get('owner/b'))).toEqual([1]);
    expect(got.repos.get('owner/c')).toEqual([]);
    const a = got.repos.get('owner/a')!;
    expect(a.find((i) => i.number === 1)).toMatchObject({
      repo: 'owner/a', kind: 'issue', url: 'https://github.com/owner/a/issues/1', title: 'One', author: 'dev', labels: ['hopper'], assignees: ['dev'],
    });
    expect(a.find((i) => i.number === 1)!.pull).toBeUndefined();
    expect(a.find((i) => i.number === 5)).toMatchObject({
      kind: 'pull', url: 'https://github.com/owner/a/pull/5', pull: { headRef: 'issue-1', headOid: 'abc', base: 'dev', isDraft: false, mergeable: 'MERGEABLE', checks: 'pending' },
    });
    expect(a.find((i) => i.number === 6)!.pull).toMatchObject({ isDraft: true, mergeable: 'UNKNOWN', checks: 'none' });
    expect(graphqlRequests(h)).toHaveLength(1);
    expect(restListings(h)).toEqual([]);
  });

  it(`60 repositories are ⌈60/${LISTING_REPOS_MAX}⌉ requests`, async () => {
    const names = Array.from({ length: 60 }, (_, i) => `r${i}`);
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: names.map((n) => repo(n, [{ number: 1, labels: ['hopper'] }])) }] });
    const got = await h.api.listRepos!(names.map((n) => `owner/${n}`), LABELS);
    expect([...got.repos.keys()].sort()).toEqual(names.map((n) => `owner/${n}`).sort());
    expect(graphqlRequests(h)).toHaveLength(Math.ceil(60 / LISTING_REPOS_MAX));
  });

  it('pages only a repository with more items than a page, and gets every item', async () => {
    h = await startApp({ pageSize: 2, installations: [{ id: 11, account: 'owner', repos: [
      repo('a', [1, 2, 3, 4, 5].map((n) => ({ number: n, labels: ['hopper'] }))),
      repo('b', [{ number: 1, labels: ['hopper'] }]),
    ] }] });
    const got = await h.api.listRepos!(['owner/a', 'owner/b'], LABELS);
    expect(numbers(got.repos.get('owner/a'))).toEqual([1, 2, 3, 4, 5]);
    expect(numbers(got.repos.get('owner/b'))).toEqual([1]);
    const [, ...pages] = graphqlRequests(h);
    expect(pages).toHaveLength(2);
    for (const p of pages) expect(Object.values((p.body as { variables: Record<string, unknown> }).variables)).not.toContain('b');
  });

  it('lists the same issues as the REST listing of each label', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [
      { number: 1, labels: ['hopper'] }, { number: 2, labels: ['hopper:high'] }, { number: 3, labels: ['hopper', 'hopper:high'] },
      { number: 4, labels: ['other'] }, { number: 5, labels: ['hopper'], state: 'closed' },
    ])] }] });
    const rest = new Set<number>();
    for (const l of LABELS) for (const i of await h.api.listOpenIssues('owner/a', l)) rest.add(i.number);
    const got = await h.api.listRepos!(['owner/a'], LABELS);
    expect(numbers(got.repos.get('owner/a'))).toEqual([...rest].sort((a, b) => a - b));
  });

  it('repositories of two installations ask with two tokens: one request for each', async () => {
    h = await startApp({ installations: [
      { id: 11, account: 'owner', repos: [repo('a', [{ number: 1, labels: ['hopper'] }])] },
      { id: 12, account: 'other', repos: [repo('b', [{ number: 2, labels: ['hopper'] }], 'other')] },
    ] });
    const got = await h.api.listRepos!(['owner/a', 'other/b'], LABELS);
    expect(numbers(got.repos.get('owner/a'))).toEqual([1]);
    expect(numbers(got.repos.get('other/b'))).toEqual([2]);
    expect(graphqlRequests(h)).toHaveLength(2);
  });

  it('a repository the app is not installed on fails only itself', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [{ number: 1, labels: ['hopper'] }])] }] });
    const got = await h.api.listRepos!(['owner/a', 'owner/gone'], LABELS);
    expect(numbers(got.repos.get('owner/a'))).toEqual([1]);
    expect(got.repos.has('owner/gone')).toBe(false);
    expect(got.repoErrors.get('owner/gone')).toMatch(/not installed/);
  });

  it('a repository GitHub does not resolve in a request fails only its alias', async () => {
    h = await startApp({ installations: [
      { id: 11, account: 'owner', repos: [repo('a', [{ number: 1, labels: ['hopper'] }])] },
      { id: 12, account: 'other', repos: [repo('b', [{ number: 2, labels: ['hopper'] }], 'other')] },
    ] });
    const { token } = await h.api.gitRemote('owner/a');
    const got = await listRepos(makeRequest(h.fake.url), token, ['owner/a', 'other/b'], LABELS);
    expect(numbers(got.repos.get('owner/a'))).toEqual([1]);
    expect(got.repoErrors.get('other/b')).toMatch(/Could not resolve to a Repository/);
    expect(graphqlRequests(h)).toHaveLength(1);
  });

  it('a request GitHub fails throws: the sync asks again', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [repo('a', [{ number: 1, labels: ['hopper'] }])] }] });
    await h.api.listRepos!(['owner/a'], LABELS); // the installation and its token, before the failure
    h.fake.fail('POST /graphql', 502, 'bad gateway', 1);
    await expect(h.api.listRepos!(['owner/a'], LABELS)).rejects.toMatchObject({ permanent: false });
  });
});
