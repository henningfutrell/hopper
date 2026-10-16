// Issue #1210: a job that reads the same pull request or issue again and again polls hopper state. The proxy says so in
// its answer (`poll`); a job on a wait for its own command that only polls is reported to the engine (`polled`), which
// types its wait and ends it after an hour.
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { WaitOn } from '../../src/domain/wait-on.ts';
import {
  createGitHubProxy, createPollWatch, holdsProxyToken, POLL_READS, POLL_WINDOW_MS, polledOn, proxyToken, type ProxyApi, type ProxyUser, type PullRequestStatus,
} from '../../src/github-proxy/index.ts';

const URL = 'https://github.com/octo/tools/pull/8';
const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 8, url: URL, state: 'open', draft: false, mergeable: 'conflicts', checks: 'passing', failedChecks: [], ...over,
});

describe('the poll watch (issue #1210)', () => {
  it('counts the same read of one job in the window; other reads and other jobs apart', () => {
    const w = createPollWatch();
    expect([0, 60_000, 120_000].map((at) => w.read('job-1', 'pr.status/octo/tools/8', at))).toEqual([1, 2, 3]);
    expect(w.read('job-2', 'pr.status/octo/tools/8', 120_000)).toBe(1);
    expect(w.read('job-1', 'pr.status/octo/tools/9', 120_000)).toBe(1);
    expect(w.read('job-1', 'pr.status/octo/tools/8', 120_000 + POLL_WINDOW_MS)).toBe(1);
  });

  it('what a poll waits on: a pull request\'s checks, its merge, or an issue', () => {
    expect(polledOn('pr.checks', 'octo/tools', 8)).toEqual({ kind: 'pull_request', repo: 'octo/tools', number: 8, about: 'checks' });
    expect(polledOn('pr.status', 'octo/tools', 8)).toEqual({ kind: 'pull_request', repo: 'octo/tools', number: 8, about: 'merge' });
    expect(polledOn('pr.view', 'octo/tools', 8)).toEqual({ kind: 'pull_request', repo: 'octo/tools', number: 8, about: 'merge' });
    expect(polledOn('issue.comments', 'octo/tools', 7)).toEqual({ kind: 'item', repo: 'octo/tools', number: 7 });
  });
});

describe('the broker and a job that polls (issue #1210)', () => {
  const key = mintLinkKey().privateKey;
  const bearer = `Bearer ${proxyToken(key, 'u1', 'job-1')}`;
  const ask = { op: 'pr.status', repo: 'octo/tools', number: '8' };

  function setup(job: Job) {
    const events: NewEvent[] = [];
    const polled: { jobId: string; on: WaitOn; reads: number; answer: string }[] = [];
    let at = Date.parse('2026-10-14T10:00:00Z');
    const user: ProxyUser = {
      id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); },
      pullRequest: () => ({ known: status() }),
    };
    const api: ProxyApi = {
      perform: async () => ({ number: 8, url: URL, title: 't' }), repo: async () => { throw new Error('not read'); },
      head: async () => { throw new Error('not read'); }, pullRequestBase: async () => { throw new Error('not read'); },
    };
    const proxy = createGitHubProxy({
      user: () => user, limiter: { take: () => undefined }, log: () => {}, now: () => at,
      connection: () => ({ jobRepositories: () => ['octo/tools'], contribution: () => false, login: () => 'owner', api: () => api }),
      polled: (_u, j, p) => { polled.push({ jobId: j.id, on: p.on, reads: p.reads, answer: p.answer }); },
    });
    const askEvery = async (n: number, body: Record<string, string> = ask) => {
      const answers = [];
      for (let i = 0; i < n; i++) { answers.push(await proxy.handle(bearer, body)); at += 60_000; }
      return answers;
    };
    return { proxy, events, polled, askEvery };
  }

  it('the same read asked again and again: answered, with a poll note that names pr wait', async () => {
    const t = setup({ id: 'job-1', status: 'running', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job);
    const answers = await t.askEvery(POLL_READS);
    expect(answers.slice(0, -1).every((a) => a.status === 200 && a.body.poll === undefined)).toBe(true);
    expect(answers.at(-1)).toMatchObject({ status: 200, body: { ok: true, mergeable: 'conflicts', poll: expect.stringContaining('pr wait 8 --repo octo/tools --for mergeable') } });
    expect(t.events.at(-1)).toMatchObject({ type: 'github_proxy.done', data: { op: 'pr.status', poll: POLL_READS } });
    // A running job is not on a wait: nothing to tell the engine.
    expect(t.polled).toEqual([]);
  });

  it('a job on a wait for its own command that polls: the engine is told what it polls, with the answer', async () => {
    const wait = { for: 'PR 8 to be mergeable', until: 'own command 3 ends', since: '2026-10-14T09:00:00Z', ownCommand: true as const, on: { kind: 'own_command' as const } };
    const t = setup({ id: 'job-1', status: 'waiting_on', wait, source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job);
    await t.askEvery(POLL_READS + 1);
    expect(t.polled).toHaveLength(2);
    expect(t.polled[0]).toMatchObject({ jobId: 'job-1', on: { kind: 'pull_request', repo: 'octo/tools', number: 8, about: 'merge' }, reads: POLL_READS });
    expect(t.polled[0]!.answer).toContain('"mergeable":"conflicts"');
  });

  it('a pr wait is no poll', async () => {
    const t = setup({ id: 'job-1', status: 'running', source: { source: 's', kind: 'k', key: 'x', repo: 'octo/tools' } } as Job);
    const answers = await t.askEvery(POLL_READS + 1, { op: 'pr.wait', repo: 'octo/tools', number: '8' });
    expect(answers.every((a) => a.body.poll === undefined)).toBe(true);
  });
});
