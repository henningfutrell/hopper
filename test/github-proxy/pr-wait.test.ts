// Issue #1072 part 2: a job waits on its pull request's checks through the hopper, not by asking again. `pr wait` is
// answered from the hopper's records as `pr status` is; while the checks of a pull request the hopper follows run, the
// hopper opens a watch on the job's stream (issue #613) and ends it when what it saw of the pull request changed and its
// checks ended — told by its own events, never by a timer, and never by a GitHub read.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { DomainEvent, Job, NewEvent } from '../../src/domain/types.ts';
import {
  createGitHubProxy, createPrWaits, holdsProxyToken, PR_WAIT_OWNER, prSettled, prWaitOver, proxyToken, waitRequest, type KnownPullRequest, type ProxyApi, type ProxyUser,
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
    expect(waitRequest.parse({ op: 'pr.wait', repo: 'octo/tools', number: '8', for: 'mergeable' })).toEqual({ op: 'pr.wait', repo: 'octo/tools', number: 8, for: 'mergeable' });
    expect(waitRequest.safeParse({ op: 'pr.wait', repo: 'octo/tools', number: '8', for: 'lunch' }).success).toBe(false);
    expect(waitRequest.safeParse({ op: 'pr.wait', repo: 'octo/tools', number: '8', body: 'x' }).success).toBe(false);
  });
});

describe('a wait on a pull request\'s mergeability is over on its next seen state (issue #1210)', () => {
  it('over once the hopper sees its mergeability other than it was, or it is merged or closed', () => {
    expect(prWaitOver(status({ checks: 'passing', mergeable: 'conflicts' }), { for: 'mergeable', from: 'conflicts' })).toBe(false);
    expect(prWaitOver(status({ checks: 'pending', mergeable: 'mergeable' }), { for: 'mergeable', from: 'conflicts' })).toBe(true);
    expect(prWaitOver(status({ mergeable: 'unknown' }), { for: 'mergeable', from: 'conflicts' })).toBe(false);
    expect(prWaitOver(status({ mergeable: 'conflicts' }), { for: 'mergeable', from: 'unknown' })).toBe(true);
    expect(prWaitOver(status({ state: 'merged', mergeable: 'conflicts' }), { for: 'mergeable', from: 'conflicts' })).toBe(true);
    expect(prWaitOver(status({ checks: 'pending' }), { for: 'checks' })).toBe(false);
    expect(prWaitOver(status({ checks: 'passing' }), { for: 'checks' })).toBe(true);
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
    const opened: { jobId: string; repo: string; number: number; seconds?: number; for?: string; from?: string }[] = [];
    let read = status({ checks: 'pending' });
    const user: ProxyUser = {
      id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); },
      pullRequest: () => known,
    };
    const api: ProxyApi = {
      perform: async (r) => { asked.push(r); return { ...read }; },
      repo: async () => { throw new Error('not read'); }, head: async () => { throw new Error('not read'); },
      pullRequestBase: async () => { throw new Error('not read'); },
    };
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => undefined }, log: () => {}, now: () => Date.parse('2026-10-14T10:00:00Z'),
      connection: () => ({ jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api }),
      wait: (_u, jobId, pr, seconds) => {
        opened.push({ jobId, repo: pr.repo, number: pr.number, ...(seconds !== undefined ? { seconds } : {}), ...(pr.over?.for === 'mergeable' ? { for: 'mergeable', from: pr.over.from } : {}) });
        return { id: 'w-1', deadline: '2026-10-14T10:10:00.000Z' };
      },
    });
    return { proxy, events, asked, opened, performs: (s: PullRequestStatus) => { read = s; } };
  }

  it('--for mergeable on a pull request with conflicts: a watch, though its checks ended (issue #1210)', async () => {
    const t = setup({ known: status({ checks: 'passing', mergeable: 'conflicts' }) });
    expect(await t.proxy.handle(bearer, { ...ask, for: 'mergeable' })).toMatchObject({ status: 202, body: { ok: true, mergeable: 'conflicts', wait: 'open', waitId: 'w-1' } });
    expect(t.opened).toEqual([{ jobId: 'job-1', repo: 'octo/tools', number: 8, seconds: 600, for: 'mergeable', from: 'conflicts' }]);
    expect(t.asked).toEqual([]);
  });

  it('--for mergeable on a merged pull request: answered now, `wait: settled`', async () => {
    const t = setup({ known: status({ state: 'merged', mergeable: 'unknown' }) });
    expect(await t.proxy.handle(bearer, { ...ask, for: 'mergeable' })).toMatchObject({ status: 200, body: { wait: 'settled' } });
    expect(t.opened).toEqual([]);
  });

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

  it('one the hopper does not follow, its checks running: says how to wait on it with HOPPER_WAITING (issue #1731)', async () => {
    const t = setup({});
    const answer = await t.proxy.handle(bearer, ask);
    expect(answer).toMatchObject({ status: 200, body: { wait: 'none', waitOn: 'pr octo/tools#8 checks' } });
    expect((answer.body as { note: string }).note).toContain('HOPPER_WAITING');
  });

  it('one the hopper does not follow, its checks ended: `wait: settled` (issue #1731)', async () => {
    const t = setup({});
    t.performs(status({ checks: 'failing' }));
    expect(await t.proxy.handle(bearer, ask)).toMatchObject({ status: 200, body: { checks: 'failing', wait: 'settled' } });
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
      events: { subscribe: (l) => { listeners.push(l); return () => {}; } },
      pullRequest: () => known,
      endWait: (jobId, answer) => { ended.push({ jobId, answer }); },
    };
    // A new object each call, over the same event log, as src/http/job-github.ts makes one.
    const waits = createPrWaits({ user: () => ({ ...user }), newId: () => `w-${++n}`, log: () => {} });
    const hear = (type: string) => { for (const l of [...listeners]) l({ type, jobId: 'job-0', data: {} } as unknown as DomainEvent); };
    return { waits, watches, stream, ended, hear, listeners, set: (k: KnownPullRequest) => { known = k; } };
  }

  // Issue #1383: each redrive added a listener, and each listener redrives on a change, so the listeners doubled with
  // every change heard: the event loop was held longer at each one, and the memory grew.
  it('hears a user\'s event log once, however often it is asked again', () => {
    const t = setup();
    t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status() });
    t.waits.open('u1', 'job-2', { repo: 'octo/tools', number: 8, status: status() });
    for (let i = 0; i < 5; i++) { t.waits.redrive('u1'); t.hear('job.pull_request_seen'); }
    expect(t.listeners).toHaveLength(1);
  });

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

  it('a wait on its mergeability ends on the next state the hopper sees, and the job goes on with it (issue #1210)', () => {
    const t = setup();
    t.set({ known: status({ checks: 'passing', mergeable: 'conflicts' }) });
    const w = t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status({ checks: 'passing', mergeable: 'conflicts' }), over: { for: 'mergeable', from: 'conflicts' } });
    expect(w?.body).toEqual({ owner: PR_WAIT_OWNER, repo: 'octo/tools', number: '8', for: 'mergeable', from: 'conflicts' });
    t.hear('job.pull_request_seen');
    expect(t.watches[0]!.ended).toBeUndefined();
    // A wait on its checks is another watch.
    expect(t.waits.open('u1', 'job-1', { repo: 'octo/tools', number: 8, status: status() })?.id).toBe('w-2');
    t.set({ known: status({ checks: 'pending', mergeable: 'mergeable' }) });
    t.hear('job.pull_request_seen');
    expect(t.watches.map((x) => [x.id, x.ended])).toEqual([['w-1', 'github.pr_settled'], ['w-2', undefined]]);
    expect(t.ended).toEqual([{ jobId: 'job-1', answer: `${JSON.stringify(status({ checks: 'pending', mergeable: 'mergeable' }))}\n` }]);
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
        events: { subscribe: () => () => {} },
      }),
      log: () => {},
    });
    await waits.redrive('u1', 'job-1');
    expect(asked).toEqual([]);
  });

  // Issue #1383: as the pull request waits, each redrive added a listener that redrives on a vault change.
  it('hear a user\'s event log once, however often they are asked again', async () => {
    const listeners: ((e: DomainEvent) => void)[] = [];
    const events = { subscribe: (l: (e: DomainEvent) => void) => { listeners.push(l); return () => {}; } };
    const waits = createSkillWaits({
      broker: { again: async () => undefined } as unknown as SkillBroker,
      // A new object each call, over the same event log, as src/http/job-skill.ts makes one.
      user: () => ({
        stream: { open: () => { throw new Error('not opened'); }, emit: () => undefined, finish: () => undefined, repo: { openWatches: () => [] } },
        events,
      }),
      log: () => {},
    });
    for (let i = 0; i < 5; i++) {
      await waits.redrive('u1');
      for (const l of [...listeners]) l({ type: 'vault.secret_set', data: {} } as unknown as DomainEvent);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(listeners).toHaveLength(1);
  });
});
