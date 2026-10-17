// Issue #1279: GitHub refuses a pull request's check runs or statuses to the job's user's connection ("Resource not
// accessible by integration": the hopper's app lacks Checks: read or Commit statuses: read on that installation). `pr
// status` and `pr wait` say why the checks are `unknown`, and the fix; `pr checks` answers what it may read and says what
// it may not; refused both, it fails with the fix. GitHub is a small fake on loopback.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyApi, ProxyGitHubError } from '../../src/github-proxy/index.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A fake GitHub with pull request 8 of octo/tools at head `abc`; `refuse` names the reads it answers 403. */
async function github(refuse: ('checks' | 'statuses')[]): Promise<string> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const refused = { message: 'Resource not accessible by integration' };
    if (path === '/repos/octo/tools/pulls/8') {
      return send(200, { number: 8, title: 't', state: 'open', html_url: 'https://github.com/octo/tools/pull/8', draft: false, merged: false, mergeable: true, head: { ref: 'b', sha: 'abc' }, base: { ref: 'main' } });
    }
    if (path === '/repos/octo/tools/commits/abc/check-runs') {
      return refuse.includes('checks') ? send(403, refused) : send(200, { total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] });
    }
    if (path === '/repos/octo/tools/commits/abc/status') {
      return refuse.includes('statuses') ? send(403, refused) : send(200, { state: 'success', statuses: [{ context: 'ci', state: 'success' }] });
    }
    send(404, { message: 'Not Found' });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const api = async (refuse: ('checks' | 'statuses')[]) =>
  createProxyApi({ apiUrl: await github(refuse), token: async () => 't', renew: async () => 't' });

describe('checks GitHub refuses to the job\'s connection', () => {
  it('pr status: checks unknown, and checksWhy names the permission and the fix', async () => {
    const r = await (await api(['checks'])).perform({ op: 'pr.status', repo: 'octo/tools', number: 8 });
    expect(r.checks).toBe('unknown');
    expect(r.checksWhy).toMatch(/lacks Checks: read/);
    expect(r.checksWhy).toMatch(/accept its new permissions on the installation/);
  });

  it('pr status: checks it may read say no checksWhy', async () => {
    const r = await (await api([])).perform({ op: 'pr.status', repo: 'octo/tools', number: 8 });
    expect(r.checks).toBe('passing');
    expect(r.checksWhy).toBeUndefined();
  });

  it('pr checks: the statuses when only the check runs are refused, and what it may not read, with the fix', async () => {
    const r = await (await api(['checks'])).perform({ op: 'pr.checks', repo: 'octo/tools', number: 8 });
    expect(r.checks).toEqual([]);
    expect(r.statuses).toEqual([{ context: 'ci', state: 'success' }]);
    expect(r.unreadable).toEqual(['checks']);
    expect(r.checksWhy).toMatch(/lacks Checks: read/);
  });

  it('pr checks: both refused fails, and the failure says the fix', async () => {
    const err = await (await api(['checks', 'statuses'])).perform({ op: 'pr.checks', repo: 'octo/tools', number: 8 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyGitHubError);
    expect((err as ProxyGitHubError).status).toBe(403);
    expect((err as Error).message).toMatch(/Resource not accessible by integration/);
    expect((err as Error).message).toMatch(/lacks Checks: read and Commit statuses: read/);
  });
});
