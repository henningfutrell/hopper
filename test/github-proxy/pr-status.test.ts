// Issue #1072: a job asks the hopper, not GitHub, where its pull request stands. `pr status` is answered from what the
// hopper already knows — the Pull requests list (what following the pull request last saw) and the work-item ledger —, and
// only a pull request it does not know is read on GitHub, then kept in the repo-query cache, so a job that waits asks GitHub once while it is fresh.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { PullRequestCard } from '../../src/domain/pull-request-list.ts';
import type { PullRequestSeen } from '../../src/domain/pull-requests.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import {
  checkRequest, createGitHubProxy, holdsProxyToken, knownPullRequest, REPO_QUERY_FRESH_MS, proxyRequest, proxyToken, type ProxyApi, type ProxyRequest, type ProxyUser,
} from '../../src/github-proxy/index.ts';

const URL = 'https://github.com/octo/tools/pull/8';

const card = (over: Partial<PullRequestCard> = {}): PullRequestCard => ({
  jobId: 'job-0', repo: 'octo/tools', issue: { number: 7, url: 'https://github.com/octo/tools/issues/7' }, pullRequest: { number: 8, url: URL },
  part: false, state: 'open', checks: 'failing', mergeable: 'mergeable', draft: false, base: 'dev', yolo: true, waits: 'checks failing', ...over,
});
const seen: PullRequestSeen = { draft: false, conflicting: false, checks: 'failing', base: 'dev', headRef: 'issue-7', failedChecks: [{ name: 'pr / test', url: 'https://github.com/octo/tools/runs/1', reported: ['a.ts:3: boom'] }] };
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  key: 'https://github.com/octo/tools/issues/7', state: 'pr_open', stateSince: '2026-10-13T10:00:00Z', eventState: 'pr_open', eventAt: '2026-10-13T10:00:00Z',
  jobId: 'job-0', pullRequest: URL, pullRequestState: 'open', waitingOn: 'its pull request: checks and the merge', keptWork: [], version: 3, ...over,
});

describe('a pull request\'s status from what the hopper knows (issue #1072)', () => {
  it('a followed pull request: its state, checks and failed checks as the Pull requests list shows them, and its work item', () => {
    expect(knownPullRequest(8, URL, { card: card(), seen, item: item() })).toEqual({
      number: 8, url: URL, state: 'open', draft: false, mergeable: 'mergeable', checks: 'failing', base: 'dev', head: 'issue-7', waits: 'checks failing',
      failedChecks: [{ name: 'pr / test', url: 'https://github.com/octo/tools/runs/1', reported: ['a.ts:3: boom'] }],
      item: { key: 'https://github.com/octo/tools/issues/7', state: 'pr_open', waitingOn: 'its pull request: checks and the merge' },
    });
  });

  it('a merged or closed one the ledger knows, with no card: its end; nothing about checks', () => {
    expect(knownPullRequest(8, URL, { item: item({ state: 'done', eventState: 'done', pullRequestState: 'merged', waitingOn: undefined }) }))
      .toEqual({ number: 8, url: URL, state: 'merged', draft: false, mergeable: 'unknown', checks: 'unknown', failedChecks: [], item: { key: 'https://github.com/octo/tools/issues/7', state: 'done' } });
    expect(knownPullRequest(8, URL, { item: item({ state: 'dropped', pullRequestState: 'abandoned' }) })).toMatchObject({ state: 'closed' });
  });

  it('nothing it knows: a card not checked yet, an open one only the ledger names, or none — GitHub is read', () => {
    expect(knownPullRequest(8, URL, { card: card({ checks: 'unknown', mergeable: 'unknown', waits: 'not checked yet' }), item: item() })).toBeUndefined();
    expect(knownPullRequest(8, URL, { item: item() })).toBeUndefined();
    expect(knownPullRequest(8, URL, {})).toBeUndefined();
  });

  it('is a read: a job asks it on any repository', () => {
    const req: ProxyRequest = proxyRequest.parse({ op: 'pr.status', repo: 'else/where', number: '8' });
    expect(req).toEqual({ op: 'pr.status', repo: 'else/where', number: 8 });
    expect(checkRequest(req, { jobId: 'j', repo: 'octo/tools' }, ['octo/tools'])).toEqual({ ok: true });
  });
});

describe('the broker answers pr status from the hopper first (issue #1072)', () => {
  const key = mintLinkKey().privateKey;
  const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job;
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  const ask = { op: 'pr.status', repo: 'octo/tools', number: '8' };

  function setup(known: ReturnType<NonNullable<ProxyUser['pullRequest']>>) {
    const events: NewEvent[] = [];
    let now = 1_000_000;
    const asked: ProxyRequest[] = [];
    const user: ProxyUser = {
      id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); },
      pullRequest: () => known,
    };
    const api: ProxyApi = {
      perform: async (r) => { asked.push(r); return { number: 8, url: URL, state: 'open', draft: false, mergeable: 'mergeable', checks: 'pending', failedChecks: [], base: 'dev', head: 'issue-7' }; },
      repo: async () => { throw new Error('not read'); }, head: async () => { throw new Error('not read'); },
      pullRequestBase: async () => { throw new Error('not read'); },
    };
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => undefined }, log: () => {}, now: () => now,
      connection: () => ({ jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api }),
    });
    return { proxy, events, asked, later: (ms: number) => { now += ms; } };
  }

  it('a pull request the hopper follows: answered from its records, GitHub not asked, `source: hopper` on the job\'s timeline', async () => {
    const known = knownPullRequest(8, URL, { card: card(), seen, item: item() })!;
    const t = setup({ known, item: known.item });
    const r = await t.proxy.handle(bearer, ask);
    expect(r).toMatchObject({ status: 200, body: { ok: true, op: 'pr.status', repo: 'octo/tools', source: 'hopper', state: 'open', checks: 'failing', waits: 'checks failing' } });
    expect(t.asked).toEqual([]);
    expect(t.events.at(-1)).toMatchObject({ type: 'github_proxy.done', jobId: 'job-1', data: { op: 'pr.status', number: 8, url: URL, source: 'hopper' } });
  });

  it('one it does not know: read on GitHub once, with its work item; asked again while fresh, the repo-query cache answers', async () => {
    const t = setup({ item: { key: 'https://github.com/octo/tools/issues/7', state: 'working' } });
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ status: 200, body: { source: 'github', checks: 'pending', item: { state: 'working' } } });
    t.later(REPO_QUERY_FRESH_MS - 1);
    expect(await t.proxy.handle(bearer, { ...ask, repo: 'Octo/Tools' })).toMatchObject({ status: 200, body: { source: 'cache', checks: 'pending' } });
    expect(t.asked).toHaveLength(1);
    expect(t.events.map((e) => (e.data as { source?: string }).source)).toEqual(['github', 'cache']);
    t.later(2);
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ body: { source: 'github' } });
    expect(t.asked).toHaveLength(2);
  });
});
