// Issue #2088: what the pending approvals read of GitHub, with the person's own connection. A loopback GitHub answers, each
// answer with an ETag, and a 304 to an If-None-Match that still matches.
//
// Feature: Pending approvals read across the intake orgs
//   Scenario: discovery across more than one org
//     Given repositories of two intake orgs, an archived one, and one of an owner that is no intake org
//     Then each waiting run of the intake orgs' repositories that are not archived is read, and only those
//   Scenario: only what the connection can approve
//     Given a waiting run whose environments someone else approves
//     Then it is no pending approval
//   Scenario: an unchanged answer costs no call
//     When the read runs again with the answers kept from the read before
//     Then each GET is sent with its ETag, GitHub answers 304, and the same approvals are read
//   Scenario: a repository GitHub refuses
//     Then it is a problem with GitHub's reason, and the other repositories are read
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovalsGitHub } from '../../src/pending-approvals/github.ts';
import { conditionalAnswers } from '../../src/repo-checks/conditional.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(undefined))); server = undefined; });

type Repo = { full_name: string; owner: { login: string }; archived: boolean };
const repo = (full: string, archived = false): Repo => ({ full_name: full, owner: { login: full.split('/')[0]! }, archived });
const run = (id: number, name: string, title: string) => ({ id, name, display_title: title, html_url: `https://github.example/runs/${id}`, created_at: '2026-10-08T10:00:00Z' });
const env = (name: string, can: boolean) => ({ environment: { name }, current_user_can_approve: can, wait_timer_started_at: '2026-10-08T10:05:00Z' });

/** 100 repositories of an owner that is no intake org fill the first page of `GET /user/repos`: the read goes on to the second. */
const FILLER = Array.from({ length: 100 }, (_, i) => repo(`someone/r${i}`));
const REPOS = [...FILLER, repo('Acme/gss'), repo('acme/iac'), repo('acme/old', true), repo('platform-co/platform')];
const RUNS: Record<string, unknown[]> = {
  'Acme/gss': [run(11, 'promote', 'Promote build 11')],
  'acme/iac': [run(21, 'terraform', 'Apply uat'), run(22, 'terraform', 'Apply audit')],
  'acme/old': [run(31, 'promote', 'never read')],
  'platform-co/platform': [run(41, 'promote', 'Promote build 41')],
  'someone/r0': [run(51, 'promote', 'never read')],
};
const DEPLOYMENTS: Record<number, unknown[]> = {
  11: [env('production-approval', true)], 21: [env('iac-apply-uat', true)], 22: [env('audit', false)],
  41: [env('production-approval', true)],
};

interface Seen { url: string; headers: IncomingHttpHeaders; status: number }

async function github(o: { refuse?: string } = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const send = (status: number, body: unknown) => {
      seen.push({ url: `${url.pathname}${url.search}`, headers: req.headers, status });
      const text = JSON.stringify(body);
      const etag = `"${Buffer.from(text).toString('base64url').slice(-16)}"`;
      if (status === 200 && req.headers['if-none-match'] === etag) { seen.at(-1)!.status = 304; res.writeHead(304, { etag }); res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 200 ? { etag } : {}) });
      res.end(text);
    };
    if (url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? '1'), per = Number(url.searchParams.get('per_page') ?? '30');
      return send(200, REPOS.slice((page - 1) * per, page * per));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs(?:\/(\d+)\/pending_deployments)?$/.exec(url.pathname);
    if (m) {
      const full = `${m[1]}/${m[2]}`;
      if (full === o.refuse) return send(403, { message: 'Resource not accessible by integration' });
      if (m[3]) return send(200, DEPLOYMENTS[Number(m[3])] ?? []);
      if (url.searchParams.get('status') !== 'waiting') return send(400, { message: 'status=waiting only' });
      const runs = RUNS[full] ?? [];
      return send(200, { total_count: runs.length, workflow_runs: runs });
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const reader = (apiUrl: string) => createApprovalsGitHub({ apiUrl, token: async () => 'token-1', renew: async () => 'token-1' });

describe('the pending approvals read (issue #2088)', () => {
  it('reads every waiting run of the intake orgs\' repositories that are not archived, and only what the connection can approve', async () => {
    const gh = await github();
    const read = await reader(gh.url).waiting(['acme', 'platform-co'], conditionalAnswers());
    expect(read.problems).toEqual([]);
    expect(read.approvals.map((a) => [a.repo, a.runId, a.environments]).sort()).toEqual([
      ['Acme/gss', 11, ['production-approval']], ['acme/iac', 21, ['iac-apply-uat']], ['platform-co/platform', 41, ['production-approval']],
    ]);
    expect(read.approvals.find((a) => a.runId === 11)).toEqual({
      repo: 'Acme/gss', runId: 11, workflow: 'promote', title: 'Promote build 11', environments: ['production-approval'],
      waitingSince: '2026-10-08T10:05:00Z', url: 'https://github.example/runs/11',
    });
    const asked = gh.seen.map((s) => s.url);
    expect(asked).toContain('/user/repos?per_page=100&page=2');
    expect(asked.some((u) => u.startsWith('/repos/acme/old/') || u.startsWith('/repos/someone/'))).toBe(false);
    expect(asked).toContain('/repos/Acme/gss/actions/runs?status=waiting&per_page=100');
    expect(gh.seen.every((s) => s.headers.authorization === 'token token-1')).toBe(true);
  });

  it('read again with the kept answers: every GET carries its ETag, GitHub answers 304, and the approvals are the same', async () => {
    const gh = await github();
    const first = conditionalAnswers();
    const before = await reader(gh.url).waiting(['acme', 'platform-co'], first);
    const calls = gh.seen.length;
    const again = await reader(gh.url).waiting(['acme', 'platform-co'], conditionalAnswers(first.kept()));
    expect(again).toEqual(before);
    const second = gh.seen.slice(calls);
    expect(second.length).toBe(calls);
    expect(second.every((s) => typeof s.headers['if-none-match'] === 'string' && s.status === 304)).toBe(true);
  });

  it('a repository GitHub refuses is a problem with its reason; the others are read', async () => {
    const gh = await github({ refuse: 'acme/iac' });
    const read = await reader(gh.url).waiting(['acme', 'platform-co'], conditionalAnswers());
    expect(read.approvals.map((a) => a.runId).sort()).toEqual([11, 41]);
    expect(read.problems).toEqual([{ where: 'acme/iac', error: expect.stringContaining('GitHub answered 403') }]);
    expect(read.problems[0]!.error).toContain('Resource not accessible by integration');
  });

  it('no intake org reads nothing', async () => {
    const gh = await github();
    expect(await reader(gh.url).waiting([], conditionalAnswers())).toEqual({ approvals: [], problems: [] });
    expect(gh.seen).toEqual([]);
  });
});
