// GitHub calls per hour by kind (issue #985 part 4, design.md "The shared rate limiter"): each call GitHub charges — an
// answer with new data or a refusal, never a 304 — counts for the last hour under its kind, which the read or write that
// made it names; a GraphQL call also counts the points it spent, from the drop in its bucket's calls left. Through the real
// `makeRequest` and the shared limiter, against a fake GitHub on loopback.
//
// Feature: calls per hour by kind
//   Scenario: a sync reads its listing, its reconcile, its in-motion cycle and a job's issue
//     Then each call counts under its kind, a 304 under none
//   Scenario: a GraphQL call
//     Then it counts its points: the drop in calls left since the last answer of its window
//   Scenario: an hour goes by
//     Then a call older than an hour no longer counts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_CALL_KINDS } from '../../src/domain/github-rate-limit.ts';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { callKindOf, createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { makeRequest } from '../../src/sources/github/http/http.ts';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

const RESET = 2_000_000_000;

/** A fake GitHub: REST answers carry an ETag (a conditional ask is a 304), `/missing` is a 404; GraphQL spends `cost` points per query. */
async function fakeGitHub(cost: number[] = []): Promise<string> {
  let graphqlLeft = 5000;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/graphql') {
        graphqlLeft -= cost.shift() ?? 1;
        res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(graphqlLeft), 'x-ratelimit-reset': String(RESET), 'x-ratelimit-resource': 'graphql' });
        return res.end('{"data":{}}');
      }
      if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function counting() {
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const traffic = createGitHubTraffic({ log: () => undefined, now: () => clock.t });
  return { clock, traffic, limiter: createGitHubLimiter({ traffic }) };
}

const QUERY = 'query { viewer { login } }';
const zero = Object.fromEntries(GITHUB_CALL_KINDS.map((k) => [k, { calls: 0, points: 0 }]));

describe('GitHub calls per hour by kind (issue #985)', () => {
  it('each read or write names its kind: intake, reconcile, the in-motion cycle, a job\'s read, a write', () => {
    for (const read of ['listRepos', 'listAssignedIssues', 'projectItems']) expect(callKindOf(read, 'POST', '/graphql', QUERY)).toBe('intake');
    expect(callKindOf('openPullRequestsIn', 'POST', '/graphql', QUERY)).toBe('reconcile');
    expect(callKindOf('pullRequestStates', 'POST', '/graphql', QUERY)).toBe('pr_cycle');
    expect(callKindOf('getIssue', 'GET', '/repos/{owner}/{repo}/issues/{issue_number}')).toBe('per_job_read');
    expect(callKindOf('pullRequest', 'POST', '/graphql', QUERY)).toBe('per_job_read');
    expect(callKindOf('addLabels', 'POST', '/repos/{owner}/{repo}/issues/{issue_number}/labels')).toBe('write');
    expect(callKindOf('merge', 'PUT', '/repos/{owner}/{repo}/pulls/{pull_number}/merge')).toBe('write');
    // No read names it: a GET or a GraphQL query is a read, anything else a write.
    expect(callKindOf(undefined, 'GET', '/user')).toBe('per_job_read');
    expect(callKindOf(undefined, 'POST', '/graphql', QUERY)).toBe('per_job_read');
    expect(callKindOf(undefined, 'POST', '/graphql', 'mutation { addComment(input: {}) { clientMutationId } }')).toBe('write');
    expect(callKindOf(undefined, 'PATCH', '/repos/{owner}/{repo}/issues/{issue_number}')).toBe('write');
  });

  it('counts each call GitHub charges under its kind, inside a pass or not; a 304 counts as none; a refusal counts', async () => {
    const { traffic, limiter } = counting();
    const url = await fakeGitHub();
    const req = makeRequest(url, limiter);
    await traffic.pass('github', async () => {
      await traffic.read('listRepos', () => req('POST /graphql', { query: QUERY }));
      await traffic.read('openPullRequestsIn', () => req('POST /graphql', { query: QUERY }));
      await traffic.read('getIssue', () => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 1 }));
      await traffic.read('getIssue', () => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 1 })); // 304
    });
    await traffic.read('pullRequestStates', () => req('POST /graphql', { query: QUERY }));
    await traffic.read('addLabels', () => req('POST /repos/{owner}/{repo}/issues/{n}/labels', { owner: 'o', repo: 'r', n: 1, labels: ['x'] }));
    await expect(req('GET /missing')).rejects.toMatchObject({ status: 404 });
    expect(traffic.hourly()).toEqual({
      ...zero,
      intake: { calls: 1, points: 1 }, reconcile: { calls: 1, points: 1 }, pr_cycle: { calls: 1, points: 1 },
      per_job_read: { calls: 2, points: 0 }, write: { calls: 1, points: 0 },
    });
    expect(limiter.view().hourly).toEqual(traffic.hourly());
  });

  it('a caller may name its kind: the GitHub watches and a job\'s own requests', async () => {
    const { traffic, limiter } = counting();
    const url = await fakeGitHub();
    await makeRequest(url, limiter, { kind: 'watch' })('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 2 });
    await makeRequest(url, limiter, { kind: 'job' })('POST /repos/{owner}/{repo}/issues', { owner: 'o', repo: 'r', title: 't' });
    expect(traffic.hourly()).toMatchObject({ watch: { calls: 1, points: 0 }, job: { calls: 1, points: 0 } });
  });

  it('a GraphQL call counts its points: the drop in calls left since the last answer of its window', async () => {
    const { traffic, limiter } = counting();
    const req = makeRequest(await fakeGitHub([1, 3, 5]), limiter);
    for (let i = 0; i < 3; i++) await traffic.read('pullRequestStates', () => req('POST /graphql', { query: QUERY }));
    expect(traffic.hourly().pr_cycle).toEqual({ calls: 3, points: 9 });
  });

  it('counts the last hour only: a call older than an hour drops out', async () => {
    const { clock, traffic, limiter } = counting();
    const req = makeRequest(await fakeGitHub(), limiter);
    await traffic.read('listRepos', () => req('POST /graphql', { query: QUERY }));
    clock.t += 30 * 60_000;
    await traffic.read('listRepos', () => req('POST /graphql', { query: QUERY }));
    expect(traffic.hourly().intake.calls).toBe(2);
    clock.t += 31 * 60_000;
    expect(traffic.hourly().intake.calls).toBe(1);
    clock.t += 30 * 60_000;
    expect(traffic.hourly()).toEqual(zero);
  });
});
