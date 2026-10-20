// Issue #2184: a direct query — a question a caller asks the hopper straight, with no GitHub issue — runs as a direct
// job whose job only looks. Its item tells the job so, names its hints, and marks the job look-only; where it stands is
// read from its newest job; the GitHub proxy refuses every write it asks, and the git proxy every push.
//
// Feature: a direct query's job only looks
//   Scenario: the query's item
//     Then its prompt starts with the look-only line, then the question, then its request id and hints
//     And its job is marked by HOPPER_DIRECT_QUERY, and has no repository
//   Scenario: where a query stands
//     Then no job is accepted; a running job is running; a question is waiting; the ends are answered, failed, cancelled
//   Scenario: the GitHub proxy and a look-only job
//     Then reads are allowed, and a pull request, an issue or a comment is refused with why
//   Scenario: the git proxy and a look-only job
//     Then a push is refused with why, and nothing reaches GitHub
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import { DIRECT_QUERY_ENV, directQueryState, isDirectQuery, LOOK_ONLY, type DirectJob } from '../../src/domain/direct-jobs.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import { directItem, directQueryId, QUERY_LINE } from '../../src/direct-jobs/index.ts';
import { checkRequest, createGitProxy, holdsProxyToken, proxyToken, type GitConnection, type GitUser } from '../../src/github-proxy/index.ts';

const query: DirectJob = {
  id: directQueryId('r-42'), title: 'Where does the otel collector run?', brief: 'Where does the otel collector run?', labels: ['direct:query'], authorizations: [],
  submittedBy: { person: 'ada@example.com', via: 'api' }, submittedAt: '2026-10-19T10:00:00.000Z',
  query: { requestId: 'r-42', callback: 'grok-bot', repos: ['octo-org/infra'], clusters: ['prod'] },
};

describe('a direct query as an item (issue #2184)', () => {
  it('runs the question after the look-only line, with its request id and hints, marked look-only', () => {
    const item = directItem(query, 'u');
    expect(item.prompt.split('\n').slice(0, 3)).toEqual([QUERY_LINE, '', 'Where does the otel collector run?']);
    expect(item.prompt).toContain('request: r-42');
    expect(item.prompt).toContain('look first in: repositories octo-org/infra; clusters prod.');
    expect(item.prompt).toContain('asked by: ada (api)');
    expect(item.prompt).not.toContain('ada@example.com');
    expect(item.env).toEqual({ HOPPER_DIRECT_JOB: query.id, [DIRECT_QUERY_ENV]: query.id });
    expect(item.repo).toBeUndefined();
    expect(isDirectQuery({ spec: { executor: 'x', payload: { env: item.env } } })).toBe(true);
    expect(isDirectQuery({ spec: { executor: 'x', payload: { env: { HOPPER_DIRECT_JOB: 'd1' } } } })).toBe(false);
  });

  it('names one id for one request id', () => {
    expect(directQueryId('r-42')).toBe(query.id);
    expect(directQueryId('r-43')).not.toBe(query.id);
    expect(query.id).toMatch(/^query-[0-9a-f]{32}$/);
  });

  it('reads where it stands from its newest job', () => {
    const job = (status: string, questions = 0) => ({ id: 'j', status, questions: Array.from({ length: questions }, () => ({ id: 'q', text: 't', tier: 'human', askedAt: 'a' })) }) as never;
    expect(directQueryState(undefined)).toBe('accepted');
    expect(directQueryState(job('queued'))).toBe('accepted');
    expect(directQueryState(job('running'))).toBe('running');
    expect(directQueryState(job('waiting_answer', 1))).toBe('waiting');
    expect(directQueryState(job('finished'))).toBe('answered');
    expect(directQueryState(job('failed'))).toBe('failed');
    expect(directQueryState(job('rejected'))).toBe('failed');
    expect(directQueryState(job('cancelled'))).toBe('cancelled');
  });
});

describe('the GitHub proxy and a look-only job (issue #2184)', () => {
  const asker = { jobId: 'j', lookOnly: true };
  const repos = ['octo-org/infra'];
  it('allows reads and refuses writes, saying why', () => {
    expect(checkRequest({ op: 'issue.view', repo: 'octo-org/infra', number: 1 }, asker, repos)).toEqual({ ok: true });
    expect(checkRequest({ op: 'pr.diff', repo: 'octo-org/infra', number: 2 }, asker, repos)).toEqual({ ok: true });
    for (const req of [
      { op: 'pr.create', repo: 'octo-org/infra', head: 'x', title: 't', body: 'b' },
      { op: 'issue.create', repo: 'octo-org/infra', title: 't', body: 'b' },
      { op: 'issue.comment', repo: 'octo-org/infra', number: 1, body: 'b' },
    ] as const) expect(checkRequest(req, asker, repos)).toEqual({ ok: false, reason: LOOK_ONLY });
  });
});

describe('the git proxy and a look-only job (issue #2184)', () => {
  it('refuses a push, saying why, and sends nothing to GitHub', async () => {
    const key = mintLinkKey().privateKey;
    const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', spec: { executor: 'x', payload: { env: { [DIRECT_QUERY_ENV]: query.id } } }, source: { source: 'direct', kind: 'direct', key: `direct:${query.id}` } } as unknown as Job;
    const events: NewEvent[] = [];
    const sent: string[] = [];
    const connection: GitConnection = {
      url: 'https://github.example', login: 'ada', token: async () => 'tok', renew: async () => 'tok',
      repo: async () => ({ canPush: true, defaultBranch: 'dev', fork: false }) as never, pullRequestBase: async () => undefined,
    };
    const user: GitUser = {
      user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); } },
      jobRepositories: () => ['octo-org/infra'], contribution: () => false, git: () => connection,
    };
    const fetch = (async (url: string) => { sent.push(url); return new Response('0000'); }) as unknown as typeof globalThis.fetch;
    const git = createGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, traffic: { gitFetch: () => undefined } as never });
    const auth = `Basic ${Buffer.from(`x:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;
    const r = await git.handle({ method: 'GET', path: 'octo-org/infra.git/info/refs', service: 'git-receive-pack', authorization: auth });
    expect(r.status).toBe(403);
    expect(String(r.body)).toContain(LOOK_ONLY);
    expect(sent).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: 'github_proxy.refused', data: expect.objectContaining({ reason: LOOK_ONLY }) })]);
  });
});
