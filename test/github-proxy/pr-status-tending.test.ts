// Issue #2497: while a tend job works on a pull request, its job follows it no more (`follow: tended`, issue #736), so what
// the records saw of it stays as it was before the tend: merge conflicts the tend job's push removed, checks of a head it
// replaced. `pr status` reads such a pull request again on GitHub, and `pr wait` opens no watch on it, since no follow
// tells the hopper when it changes.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job } from '../../src/domain/types.ts';
import {
  createGitHubProxy, holdsProxyToken, proxyToken, REPO_QUERY_FRESH_MS, type ProxyApi, type ProxyRequest, type ProxyUser, type PullRequestStatus,
} from '../../src/github-proxy/index.ts';

const URL = 'https://github.com/octo/tools/pull/8';
const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 8, url: URL, state: 'open', draft: false, mergeable: 'mergeable', checks: 'passing', failedChecks: [], base: 'dev', head: 'issue-7', ...over,
});
/** As the records saw it before its tend: merge conflicts; its card says a tend job works on it. */
const tending = status({ mergeable: 'conflicts', checks: 'passing', waits: 'tending' });

describe('pr status of a pull request a tend job works on (issue #2497)', () => {
  const key = mintLinkKey().privateKey;
  const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job;
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  const ask = { op: 'pr.status', repo: 'octo/tools', number: '8' };
  const waitAsk = { op: 'pr.wait', repo: 'octo/tools', number: '8', for: 'mergeable' };

  function setup(known: PullRequestStatus, read: Partial<PullRequestStatus>, limited = false) {
    let now = 1_000_000;
    const asked: ProxyRequest[] = [];
    const opened: string[] = [];
    const user: ProxyUser = {
      id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: () => {},
      pullRequest: () => ({ known }),
    };
    const api: ProxyApi = {
      perform: async (r) => { asked.push(r); return { ...status(), ...read }; },
      repo: async () => { throw new Error('not read'); }, head: async () => { throw new Error('not read'); },
      pullRequestBase: async () => { throw new Error('not read'); },
    };
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => (limited ? 'too many reads' : undefined) }, log: () => {}, now: () => now,
      connection: () => ({ jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api }),
      wait: (_u, jobId) => { opened.push(jobId); return { id: 'w-1', deadline: '2026-10-14T10:10:00.000Z' }; },
    });
    return { proxy, asked, opened, later: (ms: number) => { now += ms; } };
  }

  it('its tend job pushed: the merge conflicts and checks as GitHub reads them now, and the card\'s wait kept', async () => {
    const t = setup(tending, { mergeable: 'mergeable', checks: 'pending' });
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ status: 200, body: { source: 'hopper', state: 'open', mergeable: 'mergeable', checks: 'pending', waits: 'tending' } });
    expect(t.asked).toEqual([{ op: 'pr.status', repo: 'octo/tools', number: 8 }]);
    t.later(REPO_QUERY_FRESH_MS - 1);
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ body: { mergeable: 'mergeable' } });
    expect(t.asked).toHaveLength(1);
  });

  it('pr wait --for mergeable: settled at once when GitHub reads its merge conflicts other than the records say', async () => {
    const t = setup(tending, { mergeable: 'mergeable' });
    expect(await t.proxy.handle(bearer, waitAsk)).toMatchObject({ status: 200, body: { mergeable: 'mergeable', wait: 'settled' } });
    expect(t.opened).toEqual([]);
  });

  it('pr wait --for mergeable, still conflicts on GitHub: no watch, since no follow would end it; it says why', async () => {
    const t = setup(tending, { mergeable: 'conflicts' });
    const answer = await t.proxy.handle(bearer, waitAsk);
    expect(answer).toMatchObject({ status: 200, body: { mergeable: 'conflicts', wait: 'none' } });
    expect((answer.body as { note: string }).note).toContain('tend job');
    expect(t.opened).toEqual([]);
  });

  it('a pull request the hopper follows, not tended: answered from its records, GitHub not asked', async () => {
    const t = setup(status({ mergeable: 'conflicts', waits: 'conflicts' }), { mergeable: 'mergeable' });
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ body: { mergeable: 'conflicts' } });
    expect(t.asked).toEqual([]);
  });

  it('a read the limits refuse: the records\' answer, as before', async () => {
    const t = setup(tending, { mergeable: 'mergeable' }, true);
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ body: { source: 'hopper', mergeable: 'conflicts', waits: 'tending' } });
    expect(t.asked).toEqual([]);
  });
});
