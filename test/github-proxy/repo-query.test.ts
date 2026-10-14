// Issue #1074: jobs ask the hopper, not GitHub. The repo-query cache's parts — its key, when a kept answer answers now,
// what it keeps at most, what a write drops — and the broker answering a job's reads from it, with the work-item ledger's
// word beside each answer. The last test measures a job that polls its pull request, with the cache and without it.
// The whole path through the daemon is test/integration/github-proxy.test.ts.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import {
  answersNow, checkRequest, createGitHubProxy, createProxyLimiter, createRepoQueryCache, holdsProxyToken, proxyToken, queryKey, REPO_QUERY_FRESH_MS,
  type LedgerView, type ProxyApi, type ProxyRequest, type ProxyResult, type ProxyUser, type RepoQueryCache,
} from '../../src/github-proxy/index.ts';

const PR_URL = 'https://github.com/octo/tools/pull/8';

describe('the repo-query cache', () => {
  it('keys a query by its operation, its repository in any case, and its number', () => {
    expect(queryKey({ op: 'pr.diff', repo: 'Octo/Tools', number: 8 })).toBe('pr.diff octo/tools#8');
    expect(queryKey({ op: 'repo.view', repo: 'octo/tools' })).toBe('repo.view octo/tools');
  });

  it('a kept answer answers for 30 seconds; a merged pull request\'s for good, as it said or as the ledger says', () => {
    const kept = { result: { number: 8, url: PR_URL }, at: 0 };
    expect(answersNow('pr.diff', kept, REPO_QUERY_FRESH_MS - 1, undefined)).toBe(true);
    expect(answersNow('pr.diff', kept, REPO_QUERY_FRESH_MS, undefined)).toBe(false);
    const merged: LedgerView = { key: 'https://github.com/octo/tools/issues/7', state: 'done', since: '1970-01-01T00:00:00.000Z', pullRequestState: 'merged' };
    expect(answersNow('pr.diff', kept, 10 * REPO_QUERY_FRESH_MS, merged)).toBe(true);
    // Read before the merge: what was there before it.
    expect(answersNow('pr.diff', kept, 10 * REPO_QUERY_FRESH_MS, { ...merged, since: '1970-01-01T00:00:01.000Z' })).toBe(false);
    expect(answersNow('pr.view', { result: { ...kept.result, merged: true }, at: 0 }, 10 * REPO_QUERY_FRESH_MS, undefined)).toBe(true);
    // An issue may open again: never final.
    expect(answersNow('issue.view', { result: { number: 7, url: 'u', state: 'closed' }, at: 0 }, REPO_QUERY_FRESH_MS, merged)).toBe(false);
  });

  it('keeps at most its entries and its characters, the oldest pushed out first', () => {
    const c = createRepoQueryCache({ entries: 2, chars: 100 });
    c.put('a', { url: 'a' }, 0);
    c.put('b', { url: 'b' }, 0);
    c.put('c', { url: 'c' }, 0);
    expect([c.get('a'), c.get('b')?.result, c.get('c')?.result]).toEqual([undefined, { url: 'b' }, { url: 'c' }]);
    c.put('big', { url: 'x'.repeat(80) }, 0);
    expect([c.get('b'), c.get('c'), c.get('big')?.result.url]).toEqual([undefined, undefined, 'x'.repeat(80)]);
    c.put('huge', { url: 'x'.repeat(200) }, 0);
    expect(c.get('huge')).toBeUndefined();
  });

  it('a write drops every answer about the issue or pull request it changed, and nothing else', () => {
    const c = createRepoQueryCache();
    for (const key of ['issue.view octo/tools#7', 'issue.comments octo/tools#7', 'issue.view octo/tools#70', 'pr.view octo/site#7']) c.put(key, { url: key }, 0);
    c.forget('Octo/Tools', 7);
    expect(['issue.view octo/tools#7', 'issue.comments octo/tools#7', 'issue.view octo/tools#70', 'pr.view octo/site#7'].map((k) => c.get(k) !== undefined)).toEqual([false, false, true, true]);
  });
});

describe('who may ask a repo query', () => {
  const own = { jobId: 'j', own: true, repo: 'octo/tools' };
  const queries: ProxyRequest[] = [
    { op: 'pr.diff', repo: 'else/where', number: 1 }, { op: 'pr.commits', repo: 'else/where', number: 1 },
    { op: 'pr.checks', repo: 'else/where', number: 1 }, { op: 'issue.comments', repo: 'else/where', number: 1 },
  ];
  it('the hopper\'s own job, on any repository its connection sees; another user\'s job, never', () => {
    for (const q of queries) expect(checkRequest(q, own, ['octo/tools'])).toEqual({ ok: true });
    for (const q of queries) expect(checkRequest(q, { ...own, own: false }, ['octo/tools'])).toMatchObject({ ok: false });
  });
});

/** A broker over a fake GitHub that counts its reads; `merged` from when the pull request is merged (ms). */
function broker(o: { cache?: RepoQueryCache; mergedAt?: number }) {
  const key = mintLinkKey().privateKey;
  const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools', number: 7 } } as Job;
  const events: NewEvent[] = [];
  let now = 0;
  const merged = () => o.mergedAt !== undefined && now >= o.mergedAt;
  const user: ProxyUser = {
    id: 'u1', holds: (p) => holdsProxyToken(key, p), job: () => job, machineOf: () => 'm', record: (e) => { events.push(e); },
    // The ledger learns of the merge as the hopper's follow sees it.
    ledger: (url) => (url === PR_URL ? {
      key: 'https://github.com/octo/tools/issues/7', state: merged() ? 'done' : 'pr_open', since: new Date(merged() ? o.mergedAt! : 0).toISOString(),
      pullRequestState: merged() ? 'merged' : 'open',
    } : undefined),
  };
  const asked: string[] = [];
  const api: ProxyApi = {
    perform: async (r) => {
      asked.push(r.op);
      const result: ProxyResult = r.op.startsWith('pr.') ? { number: 8, url: PR_URL } : { number: 7, url: 'https://github.com/octo/tools/issues/7' };
      return r.op === 'pr.view' || r.op === 'pr.checks' ? { ...result, merged: merged() } : result;
    },
    repo: async () => { throw new Error('not read'); },
    head: async () => { throw new Error('not read'); },
    pullRequestBase: async () => { throw new Error('not read'); },
  };
  const proxy = createGitHubProxy({
    user: () => user, limiter: { take: () => undefined }, log: () => {}, now: () => now, ...(o.cache ? { cache: o.cache } : {}),
    hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api } }),
  });
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  return {
    asked, events,
    at: (ms: number) => { now = ms; },
    ask: (req: ProxyRequest) => proxy.handle(bearer, req),
  };
}

describe('the broker answers a job\'s reads from the repo-query cache (issue #1074)', () => {
  it('reads GitHub once, then answers from the cache while it is fresh, saying which and when; the ledger\'s word beside it', async () => {
    const b = broker({});
    const first = await b.ask({ op: 'pr.diff', repo: 'octo/tools', number: 8 });
    expect(first).toMatchObject({ status: 200, body: { ok: true, source: 'github', readAt: '1970-01-01T00:00:00.000Z', ledger: { state: 'pr_open', pullRequestState: 'open' } } });
    b.at(REPO_QUERY_FRESH_MS - 1);
    expect(await b.ask({ op: 'pr.diff', repo: 'octo/tools', number: 8 })).toMatchObject({ status: 200, body: { source: 'cache', readAt: '1970-01-01T00:00:00.000Z' } });
    b.at(REPO_QUERY_FRESH_MS);
    expect(await b.ask({ op: 'pr.diff', repo: 'octo/tools', number: 8 })).toMatchObject({ status: 200, body: { source: 'github' } });
    expect(b.asked).toEqual(['pr.diff', 'pr.diff']);
    expect(b.events.map((e) => e.data.source)).toEqual(['github', 'cache', 'github']);
  });

  it('a write drops what it changed: the next read is GitHub\'s', async () => {
    const b = broker({});
    await b.ask({ op: 'issue.comments', repo: 'octo/tools', number: 7 });
    await b.ask({ op: 'issue.comment', repo: 'octo/tools', number: 7, body: 'Done.' });
    expect(await b.ask({ op: 'issue.comments', repo: 'octo/tools', number: 7 })).toMatchObject({ body: { source: 'github' } });
    expect(b.asked).toEqual(['issue.comments', 'issue.comment', 'issue.comments']);
  });

  it('measured: a job that polls its pull request for 10 minutes asks GitHub 35 times, not 135', async () => {
    // Every 10 s the job reads its pull request and its checks; every 2 minutes its diff, its commits and its issue's
    // comments. The pull request merges at 5 minutes. Without the cache (it keeps nothing) every read is GitHub's.
    const run = async (cache?: RepoQueryCache): Promise<number> => {
      const b = broker({ mergedAt: 300_000, ...(cache ? { cache } : {}) });
      for (let t = 0; t < 600_000; t += 10_000) {
        b.at(t);
        await b.ask({ op: 'pr.checks', repo: 'octo/tools', number: 8 });
        await b.ask({ op: 'pr.view', repo: 'octo/tools', number: 8 });
        if (t % 120_000 === 0) {
          for (const op of ['pr.diff', 'pr.commits'] as const) await b.ask({ op, repo: 'octo/tools', number: 8 });
          await b.ask({ op: 'issue.comments', repo: 'octo/tools', number: 7 });
        }
      }
      return b.asked.length;
    };
    expect(await run(createRepoQueryCache({ entries: 0 }))).toBe(135);
    expect(await run()).toBe(35);
  });
});

describe('the repo queries need the hopper\'s GitHub as before', () => {
  it('no connection: 503, and nothing is answered from a cache', async () => {
    const key = mintLinkKey().privateKey;
    const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1' } as Job;
    const user: ProxyUser = { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: () => job, machineOf: () => 'm', record: () => {} };
    const cache = createRepoQueryCache();
    cache.put(queryKey({ op: 'pr.view', repo: 'octo/tools', number: 8 }), { number: 8, url: PR_URL }, Date.now());
    const proxy = createGitHubProxy({
      user: () => user, limiter: createProxyLimiter({ now: () => new Date() }), log: () => {}, cache,
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => ({ problem: 'the hopper\'s GitHub is not connected' }) } }),
    });
    expect(await proxy.handle(`Bearer ${proxyToken(key, 'u1', 'job-1')}`, { op: 'pr.view', repo: 'octo/tools', number: 8 })).toMatchObject({ status: 503 });
  });
});
