// Issue #563: the GitHub proxy's parts — the job's proxy token, the request it takes, who may ask what, the
// rate limits, and the broker's answer when the hopper cannot act. The whole path through the daemon is
// test/integration/github-proxy.test.ts.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import {
  checkRequest, createGitHubProxy, createProxyLimiter, filedNote, holdsProxyToken, parseProxyToken, PROXY_LIMITS, proxyRequest, proxyToken,
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

  it('the hopper\'s own job closes only its own issue, and marks a pull request ready only on its own repository (issue #652)', () => {
    const mine = { ...own, issue: 7 };
    expect(checkRequest({ op: 'issue.close', repo: 'octo/tools', number: 7 }, mine, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'issue.close', repo: 'octo/tools', number: 8 }, mine, repos))
      .toEqual({ ok: false, reason: 'a job closes only its own issue (octo/tools#7)' });
    expect(checkRequest({ op: 'issue.close', repo: 'octo/site', number: 7 }, mine, repos)).toMatchObject({ ok: false });
    expect(checkRequest({ op: 'issue.close', repo: 'octo/tools', number: 7 }, own, repos))
      .toEqual({ ok: false, reason: 'a job closes only its own issue, and this job has none' });
    expect(checkRequest({ op: 'pr.ready', repo: 'octo/tools', number: 9 }, mine, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'pr.ready', repo: 'octo/site', number: 9 }, mine, repos))
      .toEqual({ ok: false, reason: 'a job marks a pull request ready only on its own repository (octo/tools)' });
    expect(proxyRequest.safeParse({ op: 'issue.close', repo: 'o/r', number: 1, reason: 'not_planned' }).success).toBe(false);
  });

  it('another user\'s job: filing an issue only', () => {
    expect(checkRequest(create, other, repos)).toEqual({ ok: true });
    for (const req of [
      { op: 'issue.view', repo: 'octo/tools', number: 1 }, { op: 'pr.view', repo: 'octo/tools', number: 1 },
      { op: 'issue.comment', repo: 'octo/tools', number: 1, body: 'b' }, { op: 'issue.close', repo: 'octo/tools', number: 1 },
      { op: 'pr.ready', repo: 'octo/tools', number: 1 },
    ] as ProxyRequest[]) expect(checkRequest(req, other, repos)).toMatchObject({ ok: false, reason: expect.stringContaining('may only file an issue') });
  });

  it('nobody: a repository the hopper does not work on', () => {
    expect(checkRequest({ ...create, repo: 'else/where' }, own, repos)).toEqual({ ok: false, reason: 'else/where is not one of the repositories the hopper works on, so it does nothing there for a job' });
    expect(checkRequest(create, own, [])).toMatchObject({ ok: false });
  });

  it('the hopper\'s own job reads on any repository its connection sees; it writes only on the job repositories (issue #1015)', () => {
    for (const req of [
      { op: 'issue.view', repo: 'else/where', number: 1 }, { op: 'pr.view', repo: 'else/where', number: 1 },
      { op: 'repo.view', repo: 'else/where' }, { op: 'check.log', repo: 'else/where', number: 1 },
    ] as ProxyRequest[]) {
      expect(checkRequest(req, own, repos)).toEqual({ ok: true });
      expect(checkRequest(req, other, repos)).toMatchObject({ ok: false, reason: expect.stringContaining('may only file an issue') });
    }
    for (const req of [
      create, { op: 'issue.comment', repo: 'else/where', number: 1, body: 'b' }, { op: 'issue.close', repo: 'else/where', number: 1 },
      { op: 'pr.ready', repo: 'else/where', number: 1 }, { op: 'repo.fork', repo: 'else/where' },
      { op: 'pr.create', repo: 'else/where', head: 'b', title: 't', body: 'b' },
    ] as ProxyRequest[]) expect(checkRequest({ ...req, repo: 'else/where' }, own, repos)).toMatchObject({ ok: false });
  });
});

describe('a failed check\'s log (issue #993)', () => {
  const repos = ['octo/tools'];
  const read: ProxyRequest = { op: 'check.log', repo: 'octo/tools', number: 115379122001 };

  it('names the GitHub Actions job by its number', () => {
    expect(proxyRequest.parse({ op: 'check.log', repo: 'o/r', number: '115379122001' })).toEqual({ op: 'check.log', repo: 'o/r', number: 115379122001 });
    expect(proxyRequest.safeParse({ op: 'check.log', repo: 'o/r' }).success).toBe(false);
  });

  it('the hopper\'s own job reads it, on any repository (issue #1015); another user\'s job does not', () => {
    expect(checkRequest(read, { jobId: 'j', own: true, repo: 'octo/tools' }, repos)).toEqual({ ok: true });
    expect(checkRequest({ ...read, repo: 'else/where' }, { jobId: 'j', own: true, repo: 'octo/tools' }, repos)).toEqual({ ok: true });
    expect(checkRequest(read, { jobId: 'j', own: false, repo: 'guest/own' }, repos)).toMatchObject({ ok: false, reason: expect.stringContaining('may only file an issue') });
  });
});

describe('issue lineage: an issue a job files is a child of the job\'s issue (issue #729)', () => {
  const repos = ['octo/tools', 'octo/site'];
  const required: ProxyRequest = { op: 'issue.create', repo: 'octo/site', title: 't', body: 'b', required: true };

  it('a request may mark the issue a required child; from a form it comes as text', () => {
    expect(proxyRequest.parse({ op: 'issue.create', repo: 'o/r', title: 't', body: 'b', required: 'true' })).toEqual({ op: 'issue.create', repo: 'o/r', title: 't', body: 'b', required: true });
    expect(proxyRequest.safeParse({ op: 'issue.comment', repo: 'o/r', number: 1, body: 'b', required: 'true' }).success).toBe(false);
  });

  it('only the hopper\'s own job with an issue of its own files a required child', () => {
    expect(checkRequest(required, { jobId: 'j', own: true, repo: 'octo/tools', issue: 7 }, repos)).toEqual({ ok: true });
    expect(checkRequest(required, { jobId: 'j', own: true, repo: 'octo/tools' }, repos))
      .toEqual({ ok: false, reason: 'a required child is a child of the job\'s own issue, and this job has none: file it with no --required' });
    expect(checkRequest(required, { jobId: 'j', own: false, repo: 'guest/own', issue: 7 }, repos))
      .toEqual({ ok: false, reason: 'a job of another user files no required child: file it with no --required' });
  });

  it('the filed issue names its parent: a follow-up, or a required child that keeps the parent from done', () => {
    expect(filedNote('job-1', 'r1', { repo: 'octo/tools', number: 7, required: false })).toBe(
      '\n\n---\nFollow-up of octo/tools#7.\nFiled through hopper for job `job-1` (request `r1`). It is not a job: it waits for a person to triage it.');
    expect(filedNote('job-1', 'r1', { repo: 'octo/tools', number: 7, required: true })).toBe(
      '\n\n---\nRequired child of octo/tools#7: that issue is not done while this one is open.\nFiled through hopper for job `job-1` (request `r1`). It is not a job: it waits for a person to triage it.');
    expect(filedNote('job-1', 'r1')).toBe('\n\n---\nFiled through hopper for job `job-1` (request `r1`). It is not a job: it waits for a person to triage it.');
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
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => ({ problem: 'the hopper\'s GitHub is not connected' }) } }),
    });
    expect(await proxy.handle(bearer, create)).toMatchObject({ status: 503, body: { error: 'refused: the hopper\'s GitHub is not connected' } });
    expect(events.at(-1)).toMatchObject({ type: 'github_proxy.refused', jobId: 'job-1', data: { reason: 'the hopper\'s GitHub is not connected', own: true, machine: 'm' } });
  });

  it('over a limit: 429, and GitHub is not asked', async () => {
    let asked = 0;
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => 'over' }, log: () => {},
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => ({ perform: async () => { asked++; return { number: 1, url: 'u' }; }, repo: async () => { throw new Error('not read'); }, head: async () => { throw new Error('not read'); }, pullRequestBase: async () => { throw new Error('not read'); } }) } }),
    });
    expect(await proxy.handle(bearer, create)).toMatchObject({ status: 429, body: { error: 'refused: over' } });
    expect(asked).toBe(0);
  });

  it('a request it does not take: 400 naming the field', async () => {
    const proxy = createGitHubProxy({
      user: () => user, limiter: createProxyLimiter({ now: () => new Date() }), log: () => {},
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => ({ problem: 'x' }) } }),
    });
    const r = await proxy.handle(bearer, { op: 'issue.create', repo: 'octo/tools', title: 't' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/^refused: not a request the hopper takes \(body: .*\)\. sh "\$HOPPER_GH" help$/);
  });
});
