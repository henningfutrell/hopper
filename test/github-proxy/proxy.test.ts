// Issue #563: the GitHub proxy's parts — the job's proxy token, the request it takes, who may ask what, the
// rate limits, and the broker's answer when the hopper cannot act. The whole path through the daemon is
// test/integration/github-proxy.test.ts.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import {
  checkRequest, createGitHubProxy, createProxyLimiter, holdsProxyToken, parseProxyToken, PROXY_LIMITS, proxyRequest, proxyToken,
  type ProxyRequest, type ProxyUser,
} from '../../src/github-proxy/index.ts';

describe('a job\'s proxy token', () => {
  const key = mintLinkKey().privateKey;

  it('is the same for the same job, holds only under its user\'s link key, and names its user and job', () => {
    const token = proxyToken(key, 'u1', 'job-1');
    expect(proxyToken(key, 'u1', 'job-1')).toBe(token);
    const parts = parseProxyToken(token)!;
    expect(parts).toMatchObject({ userId: 'u1', jobId: 'job-1' });
    expect(holdsProxyToken(key, parts)).toBe(true);
    expect(holdsProxyToken(mintLinkKey().privateKey, parts)).toBe(false);
    expect(holdsProxyToken(key, { ...parts, jobId: 'job-2' })).toBe(false);
    expect(holdsProxyToken(key, { ...parts, userId: 'u2' })).toBe(false);
  });

  it('parses only its own shape', () => {
    expect(parseProxyToken('')).toBeUndefined();
    expect(parseProxyToken('a.b')).toBeUndefined();
    expect(parseProxyToken('a.b.c.d')).toBeUndefined();
    expect(parseProxyToken('a.b c.d')).toBeUndefined();
  });
});

describe('a request the hopper takes', () => {
  it('names an operation and only the fields it uses; numbers come as text from a form', () => {
    expect(proxyRequest.parse({ op: 'issue.view', repo: 'o/r', number: '3' })).toEqual({ op: 'issue.view', repo: 'o/r', number: 3 });
    expect(proxyRequest.safeParse({ op: 'issue.create', repo: 'o/r', title: 't', body: 'b', labels: 'hopper' }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'issue.create', repo: 'o/r', title: 't', body: 'b', assignees: 'me' }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'repo.delete', repo: 'o/r' }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'issue.create', repo: 'no-slash', title: 't', body: 'b' }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'pr.create', repo: 'o/r', head: 'a b', title: 't', body: 'b' }).success).toBe(false);
  });
});

describe('who may ask what', () => {
  const repos = ['Octo/Tools', 'octo/site'];
  const create: ProxyRequest = { op: 'issue.create', repo: 'octo/tools', title: 't', body: 'b' };
  const own = { jobId: 'j', own: true, repo: 'octo/tools' };
  const other = { jobId: 'j', own: false, repo: 'guest/own' };

  it('the hopper\'s own job: every operation on the hopper\'s repositories, a pull request only on its own', () => {
    expect(checkRequest(create, own, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'issue.comment', repo: 'octo/site', number: 1, body: 'b' }, own, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'pr.create', repo: 'octo/tools', head: 'x', title: 't', body: 'b' }, own, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'pr.create', repo: 'octo/site', head: 'x', title: 't', body: 'b' }, own, repos))
      .toEqual({ ok: false, reason: 'a job opens a pull request only on its own repository (octo/tools)' });
    expect(checkRequest({ op: 'pr.create', repo: 'octo/site', head: 'x', title: 't', body: 'b' }, { jobId: 'j', own: true }, repos))
      .toEqual({ ok: false, reason: 'a job opens a pull request only on its own repository, and this job has none' });
  });

  it('another user\'s job: filing an issue only', () => {
    expect(checkRequest(create, other, repos)).toEqual({ ok: true });
    for (const req of [
      { op: 'issue.view', repo: 'octo/tools', number: 1 }, { op: 'pr.view', repo: 'octo/tools', number: 1 },
      { op: 'issue.comment', repo: 'octo/tools', number: 1, body: 'b' },
    ] as ProxyRequest[]) expect(checkRequest(req, other, repos)).toMatchObject({ ok: false, reason: expect.stringContaining('may only file an issue') });
  });

  it('nobody: a repository the hopper does not work on', () => {
    expect(checkRequest({ ...create, repo: 'else/where' }, own, repos)).toEqual({ ok: false, reason: 'else/where is not one of the repositories the hopper works on, so it does nothing there for a job' });
    expect(checkRequest(create, own, [])).toMatchObject({ ok: false });
  });
});

describe('the rate limits', () => {
  it('count per job and per machine, per operation, over the last hour', () => {
    let now = 0;
    const limiter = createProxyLimiter({ now: () => new Date(now) });
    const { job, machine } = PROXY_LIMITS['issue.create'];
    for (let i = 0; i < job; i++) expect(limiter.take('issue.create', 'j1', 'm')).toBeUndefined();
    expect(limiter.take('issue.create', 'j1', 'm')).toBe(`this job asked for issue.create ${job} times in the last hour, its limit`);
    expect(limiter.take('issue.view', 'j1', 'm')).toBeUndefined();
    for (let i = job; i < machine; i++) expect(limiter.take('issue.create', `j-${i}`, 'm')).toBeUndefined();
    expect(limiter.take('issue.create', 'j-new', 'm')).toBe(`jobs on its machine asked for issue.create ${machine} times in the last hour, its limit`);
    expect(limiter.take('issue.create', 'j-new', 'other')).toBeUndefined();
    now += 60 * 60 * 1000;
    expect(limiter.take('issue.create', 'j1', 'm')).toBeUndefined();
  });
});

describe('the broker when the hopper cannot act', () => {
  const key = mintLinkKey().privateKey;
  const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job;
  const events: NewEvent[] = [];
  const user: ProxyUser = {
    id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); },
  };
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  const create = { op: 'issue.create', repo: 'octo/tools', title: 't', body: 'b' };

  it('no GitHub connection: 503 with why, on the job\'s timeline', async () => {
    const proxy = createGitHubProxy({
      user: () => user, limiter: createProxyLimiter({ now: () => new Date() }), log: () => {},
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], api: () => ({ problem: 'the hopper\'s GitHub is not connected' }) } }),
    });
    expect(await proxy.handle(bearer, create)).toMatchObject({ status: 503, body: { error: 'refused: the hopper\'s GitHub is not connected' } });
    expect(events.at(-1)).toMatchObject({ type: 'github_proxy.refused', jobId: 'job-1', data: { reason: 'the hopper\'s GitHub is not connected', own: true, machine: 'm' } });
  });

  it('over a limit: 429, and GitHub is not asked', async () => {
    let asked = 0;
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => 'over' }, log: () => {},
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], api: () => ({ perform: async () => { asked++; return { number: 1, url: 'u' }; } }) } }),
    });
    expect(await proxy.handle(bearer, create)).toMatchObject({ status: 429, body: { error: 'refused: over' } });
    expect(asked).toBe(0);
  });

  it('a request it does not take: 400 naming the field', async () => {
    const proxy = createGitHubProxy({
      user: () => user, limiter: createProxyLimiter({ now: () => new Date() }), log: () => {},
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], api: () => ({ problem: 'x' }) } }),
    });
    const r = await proxy.handle(bearer, { op: 'issue.create', repo: 'octo/tools', title: 't' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/^refused: not a request the hopper takes \(body: .*\)\. sh "\$HOPPER_GH" help$/);
  });
});
