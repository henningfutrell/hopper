// GitHub traffic per sync pass (issue #858, step 0: measure first): each sync pass logs one line with its REST calls per
// route, its GraphQL calls per read, and the git fetches per repository and per job; what went between passes is told by
// the next pass that ends. The calls go through the real `makeRequest` and the shared limiter, against a fake GitHub on
// loopback.
//
// Feature: what a sync pass asked of GitHub
//   Scenario: a pass reads issues and pull requests
//     Then its line counts the REST calls per route and the GraphQL calls per read
//   Scenario: a job fetches between two passes
//     Then the next pass line counts the fetch for the repository and the job, once
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { createGitHubTraffic, graphqlNameOf, routeOf } from '../../src/github-limiter/traffic.ts';
import { makeRequest } from '../../src/sources/github/app/http.ts';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

/** A fake GitHub that answers every call with `{}`, no rate limit. */
async function fakeGitHub(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":{}}'); });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function counting() {
  const lines: string[] = [];
  const traffic = createGitHubTraffic({ log: (l) => lines.push(l) });
  return { lines, traffic, limiter: createGitHubLimiter({ traffic }) };
}

const ISSUE_QUERY = 'query($owner: String!, $name: String!, $number: Int!) {\n  repository(owner: $owner, name: $name) { issue(number: $number) { title } }\n}';

describe('GitHub traffic per sync pass (issue #858)', () => {
  it('a pass logs one line: its REST calls per route, whatever the repository, and its GraphQL calls per read', async () => {
    const { lines, traffic, limiter } = counting();
    const req = makeRequest(await fakeGitHub(), limiter);
    await traffic.pass('github', async () => {
      await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: 'o', repo: 'r', issue_number: 1 });
      await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: 'o', repo: 's', issue_number: 2 });
      await req('GET /user');
      await traffic.read('pullRequest', () => req('POST /graphql', { query: ISSUE_QUERY }));
      await traffic.read('pullRequest', () => req('POST /graphql', { query: ISSUE_QUERY }));
      await req('POST /graphql', { query: ISSUE_QUERY });
    });
    expect(lines).toEqual([
      'hopper: GitHub traffic of sync pass github: REST 3 (GET /repos/{owner}/{repo}/issues/{issue_number} 2, GET /user 1), '
      + 'GraphQL 3 (pullRequest 2, repository.issue 1), git fetches 0',
    ]);
  });

  it('what went between passes — a job\'s git fetch, a call outside any pass — is told by the next pass that ends, once', async () => {
    const { lines, traffic, limiter } = counting();
    const req = makeRequest(await fakeGitHub(), limiter);
    const job = 'abcdef12-3456-7890-abcd-ef1234567890';
    traffic.gitFetch('acme/app', job);
    traffic.gitFetch('acme/app', job);
    traffic.gitFetch('acme/lib', 'fedcba98-0000-0000-0000-000000000000');
    await req('GET /user');
    await traffic.pass('github', async () => { traffic.gitFetch('acme/app', job); });
    await traffic.pass('github', async () => undefined);
    expect(lines).toEqual([
      'hopper: GitHub traffic of sync pass github: REST 0, GraphQL 0, git fetches 1 (acme/app 1; by abcdef12 1); '
      + 'between passes: REST 1 (GET /user 1), GraphQL 0, git fetches 3 (acme/app 2, acme/lib 1; by abcdef12 2, fedcba98 1)',
      'hopper: GitHub traffic of sync pass github: REST 0, GraphQL 0, git fetches 0',
    ]);
  });

  // Issue #1351: a paused or unconfigured source's pass asks nothing new of GitHub; its line says so, or it reads as a healthy zero.
  it('a pass that takes nothing new says why in its line', async () => {
    const { lines, traffic } = counting();
    await traffic.pass('github-app', async () => undefined, undefined, 'appId, slug, private key not set');
    await traffic.pass('github-app', async () => undefined);
    expect(lines).toEqual([
      'hopper: GitHub traffic of sync pass github-app (nothing new taken: appId, slug, private key not set): REST 0, GraphQL 0, git fetches 0',
      'hopper: GitHub traffic of sync pass github-app: REST 0, GraphQL 0, git fetches 0',
    ]);
  });

  it('two passes at once count each its own calls', async () => {
    const { lines, traffic, limiter } = counting();
    const req = makeRequest(await fakeGitHub(), limiter);
    await Promise.all([
      traffic.pass('one', async () => { await req('GET /user'); await req('GET /user'); }),
      traffic.pass('two', async () => { await req('GET /rate_limit'); }),
    ]);
    expect(lines.sort()).toEqual([
      'hopper: GitHub traffic of sync pass one: REST 2 (GET /user 2), GraphQL 0, git fetches 0',
      'hopper: GitHub traffic of sync pass two: REST 1 (GET /rate_limit 1), GraphQL 0, git fetches 0',
    ]);
  });

  it('a failed pass still logs its line', async () => {
    const { lines, traffic } = counting();
    await expect(traffic.pass('github', async () => { traffic.call('GET', '/user'); throw new Error('down'); })).rejects.toThrow('down');
    expect(lines).toEqual(['hopper: GitHub traffic of sync pass github: REST 1 (GET /user 1), GraphQL 0, git fetches 0']);
  });

  it('names a route with no origin and no query, and a GraphQL call with no read by its operation, else its first fields', () => {
    expect(routeOf('https://api.github.com/repositories/1/issues?page=2')).toBe('/repositories/1/issues');
    expect(graphqlNameOf('query OpenPulls($o: String!) { repository(owner: $o) { id } }')).toBe('OpenPulls');
    expect(graphqlNameOf(ISSUE_QUERY)).toBe('repository.issue');
    expect(graphqlNameOf('{ viewer { login } }')).toBe('viewer.login');
    expect(graphqlNameOf(undefined)).toBe('graphql');
  });
});
