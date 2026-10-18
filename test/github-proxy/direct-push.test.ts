// Issue #1806: with direct push on for a repository — a person's setting with yolo mode, off unless turned on —, a job's
// push may go straight to the repository's target branch (its landing branch, else its default branch), within the user's
// own write access. Only a fast-forward, as the hopper's mirror reads it: a push that rewrites the branch, or one the hopper
// cannot check, is refused. Every other kept branch stays refused. The push is an event on the job's timeline, `direct`.
//
// Feature: a job pushes straight to the target branch with direct push on
//   Scenario: direct push off: the default branch is refused
//   Scenario: direct push on and a fast-forward: the push goes to GitHub, recorded as direct
//   Scenario: direct push on and not a fast-forward: refused
//   Scenario: direct push on and the hopper cannot check: refused
//   Scenario: a repository with landing batches: the landing branch is the target, the default branch is still refused
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import { createGitProxy, holdsProxyToken, proxyToken, type GitConnection, type GitUser } from '../../src/github-proxy/index.ts';

const key = mintLinkKey().privateKey;
const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'acme/api' } } as Job;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

interface Setup { direct?: boolean; fastForward?: boolean | 'none' | 'unknown'; landing?: string }

function proxy(s: Setup) {
  const events: NewEvent[] = [];
  const sent: string[] = [];
  const asked: { repo: string; old: string; new: string }[] = [];
  const connection: GitConnection = {
    url: 'https://github.example', login: 'ada', token: async () => 'tok', renew: async () => 'tok',
    repo: async () => ({ canPush: true, defaultBranch: 'dev', fork: false }) as never, pullRequestBase: async () => undefined,
  };
  const user: GitUser = {
    user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); } },
    jobRepositories: () => ['acme/api'], contribution: () => false, git: () => connection,
    ...(s.landing ? { landingBranch: () => s.landing } : {}),
    ...(s.direct !== undefined ? { directPush: () => s.direct! } : {}),
    ...(s.fastForward === 'none' ? {} : {
      fastForward: async (push: { repo: string; old: string; new: string }) => { asked.push({ repo: push.repo, old: push.old, new: push.new }); return s.fastForward === 'unknown' ? undefined : s.fastForward !== false; },
    }),
  };
  const fetch = (async (url: string) => {
    sent.push(url);
    return new Response('0000', { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  }) as unknown as typeof globalThis.fetch;
  const git = createGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, traffic: { gitFetch: () => undefined } as never });
  return { git, events, sent, asked };
}

const auth = `Basic ${Buffer.from(`x:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const pushTo = (branch: string) => ({
  method: 'POST', path: 'acme/api.git/git-receive-pack', authorization: auth,
  body: Buffer.from(`${pkt(`${A} ${B} refs/heads/${branch}\0report-status\n`)}0000PACK`),
});
const report = async (body: unknown): Promise<string> => (Buffer.isBuffer(body) ? body.toString() : '');

describe('a job pushes straight to the target branch with direct push on (issue #1806)', () => {
  it('direct push off: the default branch is refused, and nothing reaches GitHub', async () => {
    for (const direct of [undefined, false]) {
      const p = proxy({ ...(direct === undefined ? {} : { direct }) });
      const r = await p.git.handle(pushTo('dev'));
      expect(await report(r.body)).toContain('ng refs/heads/dev a job pushes only to a branch of its own work, never to dev');
      expect(p.sent).toEqual([]);
      expect(p.asked).toEqual([]);
    }
  });

  it('direct push on and a fast-forward: the push goes to GitHub, recorded as direct', async () => {
    const p = proxy({ direct: true });
    const r = await p.git.handle(pushTo('dev'));
    expect(r.status).toBe(200);
    expect(p.asked).toEqual([{ repo: 'acme/api', old: A, new: B }]);
    expect(p.sent).toEqual(['https://github.example/acme/api.git/git-receive-pack']);
    expect(p.events).toEqual([expect.objectContaining({ type: 'github_proxy.done', data: expect.objectContaining({ op: 'git.push', repo: 'acme/api', refs: ['refs/heads/dev'], direct: ['refs/heads/dev'] }) })]);
  });

  it('a push to a branch of its own work with direct push on is no direct push', async () => {
    const p = proxy({ direct: true });
    await p.git.handle(pushTo('issue-7-fast'));
    expect(p.asked).toEqual([]);
    expect(p.events[0]!.data).not.toHaveProperty('direct');
  });

  it('direct push on and not a fast-forward: refused, the branch is never rewritten', async () => {
    const p = proxy({ direct: true, fastForward: false });
    const r = await p.git.handle(pushTo('dev'));
    expect(await report(r.body)).toContain('ng refs/heads/dev a job pushes to dev only a fast-forward: fetch it, put your commits on top, and push again');
    expect(p.sent).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ type: 'github_proxy.refused' })]);
  });

  it('direct push on and the hopper cannot check: refused', async () => {
    for (const fastForward of ['unknown', 'none'] as const) {
      const p = proxy({ direct: true, fastForward });
      const r = await p.git.handle(pushTo('dev'));
      expect(await report(r.body)).toContain('ng refs/heads/dev the hopper could not check that the push to dev is a fast-forward: push a new branch and open a pull request');
      expect(p.sent).toEqual([]);
    }
  });

  it('a repository with landing batches: the landing branch is the target; the default branch is still refused', async () => {
    const p = proxy({ direct: true, landing: 'main' });
    expect((await p.git.handle(pushTo('main'))).status).toBe(200);
    expect(p.sent).toHaveLength(1);
    expect(await report((await p.git.handle(pushTo('dev'))).body)).toContain('ng refs/heads/dev a job pushes only to a branch of its own work, never to dev');
    expect(p.sent).toHaveLength(1);
  });
});
