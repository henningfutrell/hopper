// Issue #1448: a job's git acts with the connected account of the job repository it fetches or pushes, and, for any other
// repository (its fork), with the account of the job's own repository. Each push event names the account that acted.
//
// Feature: a job's git through the account of its repository
//   Scenario: a fetch of the further account's job repository goes with that account's token
//   Scenario: a fetch of a repository of no account goes with the account of the job's own repository
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job } from '../../src/domain/types.ts';
import { createGitProxy, holdsProxyToken, proxyToken, type GitConnection, type GitUser } from '../../src/github-proxy/index.ts';

const key = mintLinkKey().privateKey;
const job = { id: 'job-1', status: 'running', laneId: 'm/lane-1', source: { source: 's', kind: 'k', key: 'x', repo: 'acme/api' } } as Job;
const accounts: Record<string, { login: string; token: string; repos: string[] }> = {
  github: { login: 'ada-home', token: 'tok-home', repos: ['home/tools'] },
  'github-2': { login: 'ada-work', token: 'tok-work', repos: ['acme/api'] },
};
const keyFor = (repo?: string) => Object.keys(accounts).find((k) => repo !== undefined && accounts[k]!.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) ?? 'github';
const connectionOf = (repo?: string): GitConnection => {
  const a = accounts[keyFor(repo)]!;
  return { url: 'https://github.example', login: a.login, token: async () => a.token, renew: async () => a.token, repo: async () => { throw new Error('not read'); }, pullRequestBase: async () => undefined };
};
const user: GitUser = {
  user: { id: 'u1', holds: (p) => holdsProxyToken(key, p), job: (id) => (id === job.id ? job : undefined), machineOf: () => 'm', record: () => undefined },
  jobRepositories: () => Object.values(accounts).flatMap((a) => a.repos), contribution: () => false, git: connectionOf,
};

function proxy() {
  const sent: { url: string; token: string }[] = [];
  const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    const basic = Buffer.from(init.headers.authorization!.replace(/^Basic /, ''), 'base64').toString('utf8');
    sent.push({ url, token: basic.split(':')[1]! });
    return new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  }) as unknown as typeof globalThis.fetch;
  const traffic = { gitFetch: () => undefined } as never;
  return { git: createGitProxy({ user: (id) => (id === 'u1' ? user : undefined), log: () => undefined, fetch, traffic }), sent };
}

const auth = `Basic ${Buffer.from(`x:${proxyToken(key, 'u1', 'job-1')}`).toString('base64')}`;

describe('a job\'s git acts with the account of its repository (issue #1448)', () => {
  it('fetches the further account\'s job repository with that account\'s token', async () => {
    const p = proxy();
    const r = await p.git.handle({ method: 'GET', path: 'acme/api.git/info/refs', service: 'git-upload-pack', authorization: auth });
    expect(r.status).toBe(200);
    expect(p.sent).toEqual([{ url: 'https://github.example/acme/api.git/info/refs?service=git-upload-pack', token: 'tok-work' }]);
  });

  it('fetches another job repository with its own account, and a repository of no account with the job\'s own repository\'s', async () => {
    const p = proxy();
    await p.git.handle({ method: 'GET', path: 'home/tools.git/info/refs', service: 'git-upload-pack', authorization: auth });
    await p.git.handle({ method: 'GET', path: 'else/where.git/info/refs', service: 'git-upload-pack', authorization: auth });
    expect(p.sent.map((s) => s.token)).toEqual(['tok-home', 'tok-work']);
  });
});
