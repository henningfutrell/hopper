// Issue #1072 part 2: a job waits on its pull request's checks through the hopper, not by asking again. `pr wait` is
// answered from the hopper's records as `pr status` is; while the checks of a pull request the hopper follows run, the
// hopper opens a watch on the job's stream (issue #613) and ends it when what it saw of the pull request changed and its
// checks ended — told by its own events, never by a timer, and never by a GitHub read.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { DomainEvent, Job, NewEvent } from '../../src/domain/types.ts';
import {
  createGitHubProxy, createPrWaits, holdsProxyToken, PR_WAIT_OWNER, prSettled, proxyToken, waitRequest, type KnownPullRequest, type ProxyApi, type ProxyUser,
  type PrWaitUser, type PullRequestStatus,
} from '../../src/github-proxy/index.ts';
import { createSkillWaits, type SkillBroker } from '../../src/skills/index.ts';

const URL = 'https://github.com/octo/tools/pull/8';
const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 8, url: URL, state: 'open', draft: false, mergeable: 'mergeable', checks: 'pending', failedChecks: [], base: 'dev', head: 'issue-7', ...over,
});

describe('when a wait on a pull request\'s checks is over (issue #1072)', () => {
  it('over once its checks end, or once it is merged or closed; not while they run', () => {
    expect(prSettled(status())).toBe(false);
    for (const checks of ['passing', 'failing', 'none', 'unknown'] as const) expect(prSettled(status({ checks }))).toBe(true);
    expect(prSettled(status({ state: 'merged' }))).toBe(true);
    expect(prSettled(status({ state: 'closed' }))).toBe(true);
  });

  it('the request: a pull request, and the most seconds to wait', () => {
    expect(waitRequest.parse({ op: 'pr.wait', repo: 'octo/tools', number: '8', timeout: '600' })).toEqual({ op: 'pr.wait', repo: 'octo/tools', number: 8, timeout: 600 });
    expect(waitRequest.safeParse({ op: 'pr.wait', repo: 'octo/tools', number: '8', body: 'x' }).success).toBe(false);
  });
});

describe('the broker answers pr wait (issue #1072)', () => {
  const key = mintLinkKey().privateKey;
  const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job;
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  const ask = { op: 'pr.wait', repo: 'octo/tools', number: '8', timeout: '600' };

  function setup(known: KnownPullRequest) {
    const events: NewEvent[] = [];
    const asked: unknown[] = [];
    const opened: { jobId: string; repo: string; number: number; seconds?: number }[] = [];
    const user: ProxyUser = {
      id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); },
      pullRequest: () => known,
    };
    const api: ProxyApi = {
      perform: async (r) => { asked.push(r); return { ...status({ checks: 'pending' }) }; },
      repo: async () => { throw new Error('not read'); }, head: async () => { throw new Error('not read'); },
      pullRequestBase: async () => { throw new Error('not read'); },
    };
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => undefined }, log: () => {}, now: () => Date.parse('2026-10-14T10:00:00Z'),
      hopper: () => ({ user, connection: { jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api } }),
      wait: (_u, jobId, pr, seconds) => {
        opened.push({ jobId, repo: pr.repo, number: pr.number, ...(seconds !== undefined ? { seconds } : {}) });
        return { id: 'w-1', deadline: '2026-10-14T10:10:00.000Z' };
      },
    });
    return { proxy, events, asked, opened };
  }

  it('checks that ended: answered at once from the hopper\'s records, `wait: settled`, GitHub not asked', async () => {
    const t = setup({ known: status({ checks: 'passing' }) });
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ status: 200, body: { ok: true, op: 'pr.status', source: 'hopper', checks: 'passing', wait: 'settled' } });
    expect(t.opened).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.events.at(-1)).toMatchObject({ type: 'github_proxy.done', data: { op: 'pr.status', source: 'hopper', wait: 'settled' } });
  });

  it('checks that run: a watch on the job\'s stream, 202 with its id and deadline; GitHub not asked', async () => {
    const t = setup({ known: status() });
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({
      status: 202, body: { ok: true, op: 'pr.status', source: 'hopper', checks: 'pending', wait: 'open', waitId: 'w-1', until: '2026-10-14T10:10:00.000Z', waitSeconds: 600 },
    });
    expect(t.opened).toEqual([{ jobId: 'job-1', repo: 'octo/tools', number: 8, seconds: 600 }]);
    expect(t.asked).toEqual([]);
    expect(t.events.at(-1)).toMatchObject({ type: 'github_proxy.done', data: { op: 'pr.status', source: 'hopper', wait: 'w-1' } });
  });

  it('one the hopper does not follow: read as pr status, `wait: none`, since nothing would tell it when the checks end', async () => {
    const t = setup({});
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ status: 200, body: { op: 'pr.status', source: 'github', checks: 'pending', wait: 'none' } });
    expect(t.opened).toEqual([]);
    expect(t.asked).toEqual([{ op: 'pr.status', repo: 'octo/tools', number: 8 }]);
  });
});

describe('the waits on pull requests (issue #1072)', () => {
  function setup() {
    const listeners: ((e: DomainEvent) => void)[] = [];
    const watches: { id: string; jobId: string; body: Record<string, string>; deadline: string; ended?: string }[] = [];
    const stream: { jobId: string; type: string; payload: unknown; request?: string }[] = [];
    const ended: { jobId: string; answer: string }[] = [];
    let known: KnownPullRequest = { known: status() };
    let n = 0;
    const user: PrWaitUser = {
      stream: {
        open: (w) => { const x = { id: w.id, jobId: w.jobId, body: w.body, deadline: `deadline+${w.seconds ?? 3600}` }; watches.push(x); return x; },
        emit: (jobId, type, payload, request) => { stream.push({ jobId, type, payload, ...(request ? { request } : {}) }); },
        finish: (jobId, request, type, payload) => {
          const w = watches.find((x) => x.id === request);
          if (!w || w.ended) return undefined;
          w.ended = type;
          stream.push({ jobId, type, payload, request });
          return true;
        },
        repo: { openWatches: (jobId) => watches.filter((w) => !w.ended && (jobId === undefined || w.jobId === jobId)) },
      },
      subscribe: (l) => { listeners.push(l); return () => {}; },
      pullRequest: () => known,
      endWait: (jobId, answer) => { ended.push({ jobId, answer }); },
    };
    const waits = createPrWaits({ user: () => user, newId: () => `w-${++n}`, log: () => {} });
    const hear = (type: string) => { for (const l of listeners) l({ type, jobId: 'job-0', data: {} } as unknown as DomainEvent); };
    return { waits, watches, stream, ended, hear, set: (k: KnownPullRequest) => { known = k; } };
  }

  it('opens one watch per job and pull request, and says on the stream that it waits', () => {
    const t = setup();
    const w = t.waits.open('u1', 'job-1', { repo: 'Octo/Tools', number: 8, status: status() }, 600);
    expect(w).toEqual({ id: 'w-1', jobId: 'job-1', body: { owner: PR_WAIT_OWNER, repo: 'octo/tools', number: '8' }, deadline: 'deadline+600' });
    expect(t.stream).toEqual([{ jobId: 'job-1', type: 'github.pr_waiting', payload: `${JSON.stringify(status())}\n`, request: 'w-1' }]);
    expect(t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status() })?.id).toBe('w-1');
    expect(t.watches).toHaveLength(1);
  });

  it('ends the watch with the status once the hopper saw the checks end; the job\'s own wait ends with it', () => {
    const t = setup();
    t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status() });
    t.hear('job.pull_request_seen');
    expect(t.watches[0]!.ended).toBeUndefined();
    t.set({ known: status({ checks: 'failing', failedChecks: [{ name: 'pr / test', url: 'https://github.com/octo/tools/runs/1' }] }) });
    t.hear('job.started');
    expect(t.watches[0]!.ended).toBeUndefined();
    t.hear('job.pull_request_seen');
    const answer = `${JSON.stringify(status({ checks: 'failing', failedChecks: [{ name: 'pr / test', url: 'https://github.com/octo/tools/runs/1' }] }))}\n`;
    expect(t.stream.at(-1)).toEqual({ jobId: 'job-1', type: 'github.pr_settled', payload: answer, request: 'w-1' });
    expect(t.ended).toEqual([{ jobId: 'job-1', answer }]);
  });

  it('a merge ends it too; a watch that is not a pull request\'s is left to its owner', () => {
    const t = setup();
    t.watches.push({ id: 'skill-1', jobId: 'job-1', body: { name: 'example-api' }, deadline: 'later' });
    t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status() });
    t.set({ known: status({ state: 'merged', checks: 'unknown' }) });
    t.waits.redrive('u1', 'job-1');
    expect(t.watches.map((w) => [w.id, w.ended])).toEqual([['skill-1', undefined], ['w-1', 'github.pr_settled']]);
  });
});

describe('the skill waits and a pull request\'s watch (issue #1072)', () => {
  it('never ask a pull request\'s watch again as a skill request', async () => {
    const asked: unknown[] = [];
    const watches = [{ id: 'w-1', jobId: 'job-1', body: { owner: PR_WAIT_OWNER, repo: 'octo/tools', number: '8' } }];
    const waits = createSkillWaits({
      broker: { again: async (...a: unknown[]) => { asked.push(a); return undefined; } } as unknown as SkillBroker,
      user: () => ({
        stream: { open: () => { throw new Error('not opened'); }, emit: () => undefined, finish: () => undefined, repo: { openWatches: () => watches } },
        subscribe: () => () => {},
      }),
      log: () => {},
    });
    await waits.redrive('u1', 'job-1');
    expect(asked).toEqual([]);
  });
});
