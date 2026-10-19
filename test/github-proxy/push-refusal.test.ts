// Issue #2042: git shows nothing of an HTTP error's body on a push's pack (the POST), only "HTTP 403". So a push refused
// there — by the hopper, or by GitHub — is answered as git's own refusal, an `ng` line per ref with the reason, which git
// shows as `! [remote rejected] … (<reason>)`; the reason says whose refusal it is. GitHub's refusal is on the job's timeline.
//
// Feature: a refused push says why
//   Scenario: GitHub refuses a push's pack with 403
//     Then the job's git is answered git's refusal, naming GitHub, its status and its text, and the push failed on the timeline
//   Scenario: the hopper refuses a push's pack (its user's GitHub connection has a problem)
//     Then the job's git is answered git's refusal, naming the hopper's rule, and nothing reaches GitHub
//   Scenario: GitHub refuses a push's ref advertisement
//     Then the job's git is answered as plain text that names GitHub, which git shows as a remote: line
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import { createGitProxy, holdsProxyToken, proxyToken, type GitConnection, type GitUser } from '../../src/github-proxy/index.ts';

const key = mintLinkKey().privateKey;
const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'acme/api' } } as Job;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function proxy(github: Response, problem?: string) {
  const events: NewEvent[] = [];
  const sent: string[] = [];
  const connection: GitConnection = {
    url: 'https://github.example', login: 'ada', token: async () => 'tok', renew: async () => 'tok',
    repo: async () => ({ canPush: true, defaultBranch: 'dev', fork: false }) as never, pullRequestBase: async () => undefined,
  };
  const user: GitUser = {
    user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: (e) => { events.push(e); } },
    jobRepositories: () => ['acme/api'], contribution: () => false, git: () => (problem ? { problem } : connection),
  };
  const fetch = (async (url: string) => { sent.push(url); return github; }) as unknown as typeof globalThis.fetch;
  const git = createGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, traffic: { gitFetch: () => undefined } as never });
  return { git, events, sent };
}

const auth = `Basic ${Buffer.from(`x:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const push = (extra: Record<string, string> = {}) => ({
  method: 'POST', path: 'other/repo.git/git-receive-pack', authorization: auth, contentType: 'application/x-git-receive-pack-request',
  body: Buffer.from(`${pkt(`${A} ${B} refs/heads/feature/x\0report-status\n`)}0000PACK`), ...extra,
});
const text = async (body: unknown): Promise<string> => {
  if (Buffer.isBuffer(body)) return body.toString();
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
};

describe('a refused push says why (issue #2042)', () => {
  it('GitHub refuses the pack with 403: git\'s refusal names GitHub, its status and its text; the push failed on the timeline', async () => {
    const p = proxy(new Response('Permission to other/repo.git denied: the organization enforces SAML SSO.\n', { status: 403, headers: { 'content-type': 'text/plain' } }));
    const r = await p.git.handle(push());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(await text(r.body)).toContain('ng refs/heads/feature/x GitHub refused the push (HTTP 403): Permission to other/repo.git denied: the organization enforces SAML SSO.');
    expect(p.events).toEqual([expect.objectContaining({ type: 'github_proxy.failed', data: expect.objectContaining({
      repo: 'other/repo', refs: ['refs/heads/feature/x'], error: 'GitHub refused the push (HTTP 403): Permission to other/repo.git denied: the organization enforces SAML SSO.',
    }) })]);
  });

  it('GitHub refuses the pack with no text: git\'s refusal still names GitHub and its status', async () => {
    const p = proxy(new Response(null, { status: 403 }));
    expect(await text((await p.git.handle(push())).body)).toContain('ng refs/heads/feature/x GitHub refused the push (HTTP 403)\n');
  });

  it('the hopper refuses the pack: git\'s refusal names the hopper\'s rule; nothing reaches GitHub', async () => {
    const p = proxy(new Response('0000'), 'the GitHub connection must be signed in again');
    const r = await p.git.handle(push());
    expect(r.status).toBe(200);
    expect(await text(r.body)).toContain('ng refs/heads/feature/x refused: the GitHub connection must be signed in again');
    expect(p.sent).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ type: 'github_proxy.refused', data: expect.objectContaining({ refs: ['refs/heads/feature/x'] }) })]);
  });

  it('GitHub refuses the ref advertisement of a push: plain text that names GitHub, which git shows as a remote: line', async () => {
    const p = proxy(new Response('Write access to repository not granted.', { status: 403, headers: { 'content-type': 'application/octet-stream' } }));
    const r = await p.git.handle({ method: 'GET', path: 'other/repo.git/info/refs', service: 'git-receive-pack', authorization: auth });
    expect(r.status).toBe(403);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(await text(r.body)).toBe('GitHub refused the push (HTTP 403): Write access to repository not granted.\n');
  });
});
