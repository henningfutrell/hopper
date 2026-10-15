// Batched GraphQL reads (issue #822): the GraphQL reads of single issues and pull requests that the adapter is asked at the
// same time — the follows of one sync run side by side — go to GitHub as one request, each read an alias in it, and each
// read gets its own answer or its own error. Against the node:http fake GitHub, through the App adapter's port.
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { GRAPHQL_BATCH_MAX } from '../../src/sources/github/http/graphql-batch.ts';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const issue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `T${number}`, labels: ['hopper'], ...extra });
const pr = (repo: string, n: number) => ({ url: `https://github.com/${repo}/pull/${n}`, createdAt: `2026-10-02T10:${String(n).padStart(2, '0')}:00Z`, isDraft: false });
const mention = (repo: string, n: number, body: string) => ({ ...pr(repo, n), state: 'OPEN' as const, body, repo });
const graphqlRequests = (a: AppHarness) => a.fake.state.requests.filter((r) => r.path === '/graphql');

describe('batched GraphQL reads (issue #822)', () => {
  it('the reads of three issues asked at the same time go to GitHub as one request, and each gets its own answer', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      issue(1, { openPullRequests: [pr('owner/a', 11)] }),
      issue(2, { mentionedBy: [mention('owner/a', 12, 'Part of #2')] }),
      issue(3, { openPullRequests: [pr('owner/a', 13)], mentionedBy: [mention('owner/a', 13, 'Closes #3')] }),
    ] }] }] });
    const api = h.api;
    const [one, two, three, mentions] = await Promise.all([
      api.openClosingPullRequests('owner/a', 1), api.openClosingPullRequests('owner/a', 2), api.openClosingPullRequests('owner/a', 3),
      api.referencingPullRequests('owner/a', 2),
    ]);
    expect(one.map((p) => p.url)).toEqual(['https://github.com/owner/a/pull/11']);
    expect(two).toEqual([]);
    expect(three.map((p) => p.url)).toEqual(['https://github.com/owner/a/pull/13']);
    expect(mentions.map((p) => [p.url, p.body])).toEqual([['https://github.com/owner/a/pull/12', 'Part of #2']]);
    expect(graphqlRequests(h)).toHaveLength(1);
  });

  it('a read asked alone goes as the plain query of that read', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1, { openPullRequests: [pr('owner/a', 11)] })] }] }] });
    expect((await h.api.openClosingPullRequests('owner/a', 1)).map((p) => p.url)).toEqual(['https://github.com/owner/a/pull/11']);
    const [asked] = graphqlRequests(h);
    expect((asked!.body as { variables: unknown }).variables).toEqual({ owner: 'owner', name: 'a', number: 1 });
  });

  it('pull requests by their numbers, asked at the same time, are one request; a number that is an issue is no pull request', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [
      issue(1, { openPullRequests: [pr('owner/a', 11)] }), issue(2, { mentionedBy: [{ ...mention('owner/a', 12, 'Closes #2'), state: 'MERGED', mergedAt: '2026-10-02T11:00:00Z' }] }),
    ] }] }] });
    const [open, merged, notOne, nothing] = await Promise.all([
      h.api.pullRequest('owner/a', 11), h.api.pullRequest('owner/a', 12), h.api.pullRequest('owner/a', 1), h.api.pullRequest('owner/a', 99),
    ]);
    expect([open?.state, merged?.state, notOne, nothing]).toEqual(['open', 'merged', undefined, undefined]);
    expect(merged?.mergedAt).toBe('2026-10-02T11:00:00Z');
    expect(graphqlRequests(h)).toHaveLength(1);
  });

  it('an issue GitHub does not know fails only its own read; the reads asked with it get their answers', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1, { openPullRequests: [pr('owner/a', 11)] })] }] }] });
    const [known, unknown] = await Promise.allSettled([h.api.openClosingPullRequests('owner/a', 1), h.api.openClosingPullRequests('owner/a', 404)]);
    expect(known.status === 'fulfilled' && known.value.map((p) => p.url)).toEqual(['https://github.com/owner/a/pull/11']);
    expect(unknown.status).toBe('rejected');
    const err = (unknown as PromiseRejectedResult).reason as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.permanent).toBe(true);
    expect(err.message).toMatch(/^pull requests of owner\/a#404: /);
    expect(graphqlRequests(h)).toHaveLength(1);
  });

  it(`more than ${GRAPHQL_BATCH_MAX} reads at the same time go in requests of at most ${GRAPHQL_BATCH_MAX}`, async () => {
    const numbers = Array.from({ length: GRAPHQL_BATCH_MAX + 5 }, (_, i) => i + 1);
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: numbers.map((n) => issue(n, { openPullRequests: [pr('owner/a', n)] })) }] }] });
    const all = await Promise.all(numbers.map((n) => h!.api.openClosingPullRequests('owner/a', n)));
    expect(all.map((prs) => prs[0]?.url)).toEqual(numbers.map((n) => `https://github.com/owner/a/pull/${n}`));
    expect(graphqlRequests(h)).toHaveLength(2);
  });

  it('a request GitHub fails fails each read in it, as the read alone would fail', async () => {
    h = await startApp({ installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [issue(1), issue(2)] }] }] });
    h.fake.fail('POST /graphql', 502, 'bad gateway', 1);
    const got = await Promise.allSettled([h.api.openClosingPullRequests('owner/a', 1), h.api.referencingPullRequests('owner/a', 2)]);
    expect(got.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const [a, b] = got.map((r) => (r as PromiseRejectedResult).reason as GitHubApiError);
    expect([a!.permanent, b!.permanent]).toEqual([false, false]);
    expect(a!.message).toMatch(/^pull requests of owner\/a#1: /);
    expect(b!.message).toMatch(/^pull requests mentioning owner\/a#2: /);
  });
});
