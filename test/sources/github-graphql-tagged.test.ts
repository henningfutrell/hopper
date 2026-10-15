// Issue #1141: tagged items come from GitHub's issue search, one search per reason and group of repositories, each query
// within GitHub's length limit, batched as aliases in GraphQL requests.
import { describe, expect, it } from 'vitest';
import { SEARCHES_MAX, SEARCH_QUERY_MAX, taggedHits, taggedItems, taggedSearches } from '../../src/sources/github/http/graphql-tagged.ts';
import type { Request } from '../../src/sources/github/http/http.ts';

describe('tagged item searches (issue #1141)', () => {
  it('one search per reason, scoped to the repositories', () => {
    expect(taggedSearches('dev', ['owner/a', 'Owner/A', 'owner/b'])).toEqual([
      { why: 'review', query: 'is:open archived:false is:pr review-requested:dev repo:owner/a repo:owner/b' },
      { why: 'mention', query: 'is:open archived:false mentions:dev repo:owner/a repo:owner/b' },
      { why: 'assign', query: 'is:open archived:false assignee:dev repo:owner/a repo:owner/b' },
    ]);
    expect(taggedSearches('dev', [])).toEqual([]);
  });

  it('groups the repositories so each query fits GitHub\'s limit, and names every repository once per reason', () => {
    const repos = Array.from({ length: 40 }, (_, i) => `an-owner/repository-${i}`);
    const searches = taggedSearches('dev', repos);
    expect(searches.every((s) => s.query.length <= SEARCH_QUERY_MAX)).toBe(true);
    for (const why of ['review', 'mention', 'assign']) {
      const named = searches.filter((s) => s.why === why).flatMap((s) => s.query.split(' ').filter((w) => w.startsWith('repo:')));
      expect(named.sort()).toEqual(repos.map((r) => `repo:${r}`).sort());
    }
  });

  it('reads issues and pull requests, with checks; an error on one hit\'s checks is unknown', () => {
    const searches = taggedSearches('dev', ['owner/a']);
    const node = (n: number, extra: object = {}) => ({
      __typename: 'Issue', number: n, url: `https://github.com/owner/a/issues/${n}`, title: `T${n}`, createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z', author: { login: 'someone' }, labels: { nodes: [{ name: 'bug' }] }, repository: { nameWithOwner: 'owner/a' }, ...extra,
    });
    const pull = (n: number, state?: string) => node(n, {
      __typename: 'PullRequest', url: `https://github.com/owner/a/pull/${n}`, isDraft: false,
      commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
    });
    const hits = taggedHits(searches, {
      data: { s0: { nodes: [pull(1, 'SUCCESS'), pull(2), pull(3, 'FAILURE')] }, s1: { nodes: [node(4)] }, s2: { nodes: [] } },
      errors: [{ message: 'no access', path: ['s0', 'nodes', 2, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] }],
    });
    expect(hits.map((h) => [h.number, h.why, h.kind, h.checks])).toEqual([
      [1, 'review', 'pull', 'passing'], [2, 'review', 'pull', 'none'], [3, 'review', 'pull', 'unknown'], [4, 'mention', 'issue', undefined],
    ]);
    expect(hits[3]).toMatchObject({ key: 'https://github.com/owner/a/issues/4', repo: 'owner/a', title: 'T4', author: 'someone', labels: ['bug'] });
    expect(() => taggedHits(searches, { data: null, errors: [{ message: 'Bad credentials' }] })).toThrow(/Bad credentials/);
  });

  it(`asks at most ${SEARCHES_MAX} searches in one request`, async () => {
    const asked: string[][] = [];
    const req = (async (_route: string, o: { variables: Record<string, string> }) => {
      asked.push(Object.values(o.variables));
      return { data: { data: Object.fromEntries(Object.keys(o.variables).map((_, i) => [`s${i}`, { nodes: [] }])) } };
    }) as unknown as Request;
    const repos = Array.from({ length: 40 }, (_, i) => `an-owner/repository-${i}`);
    await taggedItems(req, 'token', 'dev', repos);
    expect(asked.flat()).toEqual(taggedSearches('dev', repos).map((s) => s.query));
    expect(asked.every((a) => a.length <= SEARCHES_MAX)).toBe(true);
  });
});
