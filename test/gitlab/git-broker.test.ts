// Git through the hopper for GitLab (issue #1448 part 3, design.md "Jobs through GitLab"): a GitLab job's fetch and push go
// to GitLab with the token of its user's GitLab account; a push only to the job's own project, never to its default branch;
// git's push options go to GitLab as git sent them, so the push opens the merge request; each push names the account that
// acted; GitLab refusing the token ends the account. GitLab is a fetch stand-in here.
//
// Feature: a GitLab job's git through the hopper
//   Scenario: a fetch goes to the project on the account's GitLab with the account's token, never the job's
//   Scenario: a push of a branch of the job's own work goes to GitLab with its push options, and is recorded with the account
//   Scenario: a push to another project, to the default branch, or by a job of GitHub is refused, and nothing reaches GitLab
//   Scenario: a token the hopper did not give, or a job not at work, is refused
//   Scenario: GitLab refusing the token ends the account, and the job is told
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import { holdsProxyToken, proxyToken } from '../../src/github-proxy/index.ts';
import { createGitLabGitProxy, gitlabGitPath, type GitLabGitUser } from '../../src/gitlab/git-broker.ts';
import type { GitLabApi } from '../../src/gitlab/api.ts';

const key = mintLinkKey().privateKey;
const B = 'b'.repeat(40), ZERO = '0'.repeat(40);
const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
/** A receive-pack request: its ref updates, a flush, its push options, a flush, its pack. */
const pushOf = (ref: string, options: string[] = []): Buffer => Buffer.from(`${pkt(`${ZERO} ${B} ${ref}\0report-status side-band-64k push-options`)}0000${options.map(pkt).join('')}${options.length ? '0000' : ''}PACK…`);

function setup(o: { kind?: string; status?: Job['status'] } = {}) {
  const job = { id: 'job-1', status: o.status ?? 'running', laneId: 'm/lane-1', source: { source: 'gitlab-account', kind: o.kind ?? 'gitlab-account', key: 'k', url: 'https://gitlab.example/ada/tools/-/issues/1', repo: 'ada/tools', number: 1 } } as unknown as Job;
  const events: NewEvent[] = [];
  const ended: string[] = [];
  let answer = 200;
  const user: GitLabGitUser = {
    user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'desk', record: (e) => { events.push(e); } },
    gitlab: {
      git: () => ({ baseUrl: 'https://gitlab.example', account: 'ada', token: 'glpat-ada' }),
      refused: (error) => { ended.push(error); },
      act: async (fn) => fn({ defaultBranch: async () => 'main' } as unknown as GitLabApi),
    },
  };
  const sent: { url: string; method: string; user: string; token: string; body?: string }[] = [];
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    const [name, token] = Buffer.from(init.headers.authorization!.replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    sent.push({ url, method: init.method, user: name!, token: token!, ...(init.body ? { body: Buffer.from(init.body).toString('latin1') } : {}) });
    return new Response('000eunpack ok\n0000', { status: answer, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  }) as unknown as typeof globalThis.fetch;
  const proxy = createGitLabGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, newId: () => 'r1' });
  return { proxy, sent, events, ended, answerWith: (n: number) => { answer = n; } };
}

const auth = `Basic ${Buffer.from(`hopper-job:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;
const push = (ref: string, options?: string[]) => ({ method: 'POST', path: 'ada/tools.git/git-receive-pack', authorization: auth, contentType: 'application/x-git-receive-pack-request', body: pushOf(ref, options) });

describe('a GitLab job\'s git path (issue #1448 part 3)', () => {
  it('names a project with any subgroups, and nothing else', () => {
    expect(gitlabGitPath('acme/platform/api.git/info/refs', 'git-upload-pack')).toEqual({ project: 'acme/platform/api', service: 'git-upload-pack', advertise: true });
    expect(gitlabGitPath('ada/tools.git/git-receive-pack', undefined)).toEqual({ project: 'ada/tools', service: 'git-receive-pack', advertise: false });
    expect(gitlabGitPath('ada/../tools.git/info/refs', 'git-upload-pack')).toBeUndefined();
    expect(gitlabGitPath('ada/tools/info/refs', 'git-upload-pack')).toBeUndefined();
    expect(gitlabGitPath('tools.git/info/refs', 'git-upload-pack')).toBeUndefined();
    expect(gitlabGitPath('ada/tools.git/HEAD', undefined)).toBeUndefined();
  });
});

describe('a GitLab job\'s git through the hopper (issue #1448 part 3)', () => {
  it('fetches on the account\'s GitLab with the account\'s token, and records no fetch', async () => {
    const s = setup();
    const r = await s.proxy.handle({ method: 'GET', path: 'acme/platform/api.git/info/refs', service: 'git-upload-pack', authorization: auth });
    expect(r.status).toBe(200);
    expect(s.sent).toEqual([{ url: 'https://gitlab.example/acme/platform/api.git/info/refs?service=git-upload-pack', method: 'GET', user: 'oauth2', token: 'glpat-ada' }]);
    expect(s.events).toEqual([]);
  });

  it('pushes a branch of the job\'s own work with its push options, and records it with the account', async () => {
    const s = setup();
    const r = await s.proxy.handle(push('refs/heads/fix-parser', ['merge_request.create', 'merge_request.description=Closes #1']));
    expect(r.status).toBe(200);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ url: 'https://gitlab.example/ada/tools.git/git-receive-pack', method: 'POST', token: 'glpat-ada' });
    expect(s.sent[0]!.body).toContain('merge_request.create');
    expect(s.sent[0]!.body).toContain('merge_request.description=Closes #1');
    expect(s.events).toEqual([{ type: 'gitlab_proxy.done', jobId: 'job-1', data: { requestId: 'r1', machine: 'desk', as: 'ada', op: 'git.push', project: 'ada/tools', refs: ['refs/heads/fix-parser'], heads: [B] } }]);
  });

  it('refuses a push to the default branch, to another project, or by a job of GitHub; nothing reaches GitLab', async () => {
    const s = setup();
    const main = await s.proxy.handle(push('refs/heads/main'));
    expect(main.status).toBe(200); // git's own refusal, which git shows as the reason
    expect(Buffer.from(await new Response(main.body as never).arrayBuffer()).toString()).toContain('ng refs/heads/main a job pushes only to a branch of its own work, never to main: push a new branch and open a merge request');
    const other = await s.proxy.handle({ ...push('refs/heads/x'), path: 'bob/else.git/git-receive-pack' });
    expect(other.status).toBe(403);
    expect(s.sent).toEqual([]);
    expect(s.events.map((e) => [e.type, (e.data as { reason: string }).reason])).toEqual([
      ['gitlab_proxy.refused', 'a job pushes only to a branch of its own work, never to main: push a new branch and open a merge request'],
      ['gitlab_proxy.refused', 'a job pushes only to its own project (ada/tools)'],
    ]);
    const github = setup({ kind: 'github-account' });
    expect((await github.proxy.handle({ method: 'GET', path: 'ada/tools.git/info/refs', service: 'git-upload-pack', authorization: auth })).status).toBe(403);
    expect(github.sent).toEqual([]);
  });

  it('refuses a token the hopper did not give, and a job not at work', async () => {
    const s = setup();
    const forged = `Basic ${Buffer.from(`x:${proxyToken(mintLinkKey().privateKey, 'u1', 'job-1')}`).toString('base64')}`;
    expect((await s.proxy.handle({ method: 'GET', path: 'ada/tools.git/info/refs', service: 'git-upload-pack', authorization: forged })).status).toBe(401);
    expect((await s.proxy.handle({ method: 'GET', path: 'ada/tools.git/info/refs', service: 'git-upload-pack' })).status).toBe(401);
    const done = setup({ status: 'finished' });
    expect((await done.proxy.handle({ method: 'GET', path: 'ada/tools.git/info/refs', service: 'git-upload-pack', authorization: auth })).status).toBe(401);
    expect([...s.sent, ...done.sent]).toEqual([]);
  });

  it('ends the account when GitLab refuses its token, and tells the job', async () => {
    const s = setup();
    s.answerWith(401);
    const r = await s.proxy.handle(push('refs/heads/fix-parser'));
    expect(r.status).toBe(403);
    expect(s.ended).toEqual([expect.stringContaining('GitLab refused the token (401)')]);
    expect(s.events.map((e) => e.type)).toEqual(['gitlab_proxy.failed']);
  });
});
