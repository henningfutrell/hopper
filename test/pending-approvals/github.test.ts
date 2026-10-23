// Issue #2088: what the pending approvals read of GitHub, with the person's own connection. A loopback GitHub answers, each
// answer with an ETag, and a 304 to an If-None-Match that still matches.
//
// Feature: Pending approvals read across the intake orgs
//   Scenario: discovery across more than one org, only where the app is installed (issue #2258)
//     Given installations of the app on two intake orgs and on an owner that is no intake org, an archived repository,
//       and an intake org the app is not installed on, whose repositories the user's list holds
//     Then each waiting run of the installed intake orgs' repositories that are not archived is read, and only those
//     And the intake org with no installation is never read and is no problem
//   Scenario: a personal access token, which no installation holds
//     Given GitHub refuses the installations' list (403)
//     Then the repositories the token reaches are read in their place
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

/** 100 archived repositories fill the first page of the Acme installation's repositories: the read goes on to the second. */
const FILLER = Array.from({ length: 100 }, (_, i) => repo(`Acme/r${i}`, true));
/** Each installation of the app, with the repositories it reaches; `bigcorp` is an intake org the app is not installed on. */
const INSTALLED: Record<number, { login: string; repos: Repo[] }> = {
  1: { login: 'Acme', repos: [...FILLER, repo('Acme/ledger'), repo('acme/iac'), repo('acme/old', true)] },
  2: { login: 'widget-co', repos: [repo('widget-co/widgets')] },
  3: { login: 'someone', repos: [repo('someone/r0')] },
};
/** What `GET /user/repos` lists: every repository the user reaches, also those of an org the app is not installed on. */
const REPOS = [...Object.values(INSTALLED).flatMap((i) => i.repos), repo('bigcorp/agentic-hub'), repo('bigcorp/central-logging')];
const RUNS: Record<string, unknown[]> = {
  'Acme/ledger': [run(11, 'promote', 'Promote build 11')],
  'acme/iac': [run(21, 'terraform', 'Apply staging'), run(22, 'terraform', 'Apply audit')],
  'acme/old': [run(31, 'promote', 'never read')],
  'widget-co/widgets': [run(41, 'promote', 'Promote build 41')],
  'someone/r0': [run(51, 'promote', 'never read')],
  'bigcorp/agentic-hub': [run(61, 'promote', 'Promote build 61')],
};
const DEPLOYMENTS: Record<number, unknown[]> = {
  11: [env('production-approval', true)], 21: [env('iac-apply-staging', true)], 22: [env('audit', false)],
  41: [env('production-approval', true)], 61: [env('production-approval', true)],
};

interface Seen { url: string; headers: IncomingHttpHeaders; status: number }

/** `refuse`: a repository whose runs GitHub refuses; `noApp`: the token is no app's, so GitHub refuses the installations' list. */
async function github(o: { refuse?: string; noApp?: boolean } = {}): Promise<{ url: string; seen: Seen[] }> {
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
    const page = Number(url.searchParams.get('page') ?? '1'), per = Number(url.searchParams.get('per_page') ?? '30');
    const slice = <T>(all: T[]): T[] => all.slice((page - 1) * per, page * per);
    if (url.pathname === '/user/repos') return send(200, slice(REPOS));
    if (url.pathname === '/user/installations') {
      if (o.noApp) return send(403, { message: 'You must authenticate with an access token authorized to a GitHub App in order to list installations' });
      const all = Object.entries(INSTALLED).map(([id, i]) => ({ id: Number(id), account: { login: i.login } }));
      return send(200, { total_count: all.length, installations: slice(all) });
    }
    const installed = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (installed) {
      const all = INSTALLED[Number(installed[1])]?.repos ?? [];
      return send(200, { total_count: all.length, repositories: slice(all) });
    }
    // Outside the app's installations GitHub refuses the runs, as for an org the app is not installed on.
    if (url.pathname.startsWith('/repos/bigcorp/') && !o.noApp) return send(403, { message: 'Resource not accessible by integration' });
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
  it('reads every waiting run of the installed intake orgs\' repositories that are not archived, and only what the connection can approve', async () => {
    const gh = await github();
    const read = await reader(gh.url).waiting(['acme', 'bigcorp', 'widget-co'], conditionalAnswers());
    expect(read.problems).toEqual([]);
    expect(read.approvals.map((a) => [a.repo, a.runId, a.environments]).sort()).toEqual([
      ['Acme/ledger', 11, ['production-approval']], ['acme/iac', 21, ['iac-apply-staging']], ['widget-co/widgets', 41, ['production-approval']],
    ]);
    expect(read.approvals.find((a) => a.runId === 11)).toEqual({
      repo: 'Acme/ledger', runId: 11, workflow: 'promote', title: 'Promote build 11', environments: ['production-approval'],
      waitingSince: '2026-10-08T10:05:00Z', url: 'https://github.example/runs/11',
    });
    const asked = gh.seen.map((s) => s.url);
    expect(asked).toContain('/user/installations/1/repositories?per_page=100&page=2');
    expect(asked.some((u) => u.startsWith('/user/repos'))).toBe(false);
    expect(asked.some((u) => u.startsWith('/user/installations/3/'))).toBe(false);
    expect(asked.some((u) => u.startsWith('/repos/acme/old/') || u.startsWith('/repos/someone/') || u.startsWith('/repos/bigcorp/'))).toBe(false);
    expect(asked).toContain('/repos/Acme/ledger/actions/runs?status=waiting&per_page=100');
    expect(gh.seen.every((s) => s.headers.authorization === 'token token-1')).toBe(true);
  });

  it('read again with the kept answers: every GET carries its ETag, GitHub answers 304, and the approvals are the same', async () => {
    const gh = await github();
    const first = conditionalAnswers();
    const before = await reader(gh.url).waiting(['acme', 'widget-co'], first);
    const calls = gh.seen.length;
    const again = await reader(gh.url).waiting(['acme', 'widget-co'], conditionalAnswers(first.kept()));
    expect(again).toEqual(before);
    const second = gh.seen.slice(calls);
    expect(second.length).toBe(calls);
    expect(second.every((s) => typeof s.headers['if-none-match'] === 'string' && s.status === 304)).toBe(true);
  });

  it('a repository GitHub refuses is a problem with its reason; the others are read', async () => {
    const gh = await github({ refuse: 'acme/iac' });
    const read = await reader(gh.url).waiting(['acme', 'widget-co'], conditionalAnswers());
    expect(read.approvals.map((a) => a.runId).sort()).toEqual([11, 41]);
    expect(read.problems).toEqual([{ where: 'acme/iac', error: expect.stringContaining('GitHub answered 403') }]);
    expect(read.problems[0]!.error).toContain('Resource not accessible by integration');
  });

  it('a token no installation holds (a personal access token): the repositories it reaches are read in their place', async () => {
    const gh = await github({ noApp: true });
    const read = await reader(gh.url).waiting(['acme', 'bigcorp', 'widget-co'], conditionalAnswers());
    expect(read.problems).toEqual([]);
    expect(read.approvals.map((a) => a.runId).sort()).toEqual([11, 21, 41, 61]);
    expect(gh.seen.map((s) => s.url)).toContain('/user/repos?per_page=100&page=2');
  });

  it('no intake org reads nothing', async () => {
    const gh = await github();
    expect(await reader(gh.url).waiting([], conditionalAnswers())).toEqual({ approvals: [], problems: [] });
    expect(gh.seen).toEqual([]);
  });
});
