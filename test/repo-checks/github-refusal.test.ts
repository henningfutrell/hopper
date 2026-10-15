// Issue #1351: a repository's checks read that GitHub refuses with "Resource not accessible by integration" says which
// permission of the GitHub App it lacks and what to do, over REST (the x-accepted-github-permissions header) and over
// GraphQL (the field refused). A loopback GitHub answers.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepoChecksGitHub } from '../../src/repo-checks/github.ts';
import { conditionalAnswers } from '../../src/repo-checks/conditional.ts';

const REFUSED = 'Resource not accessible by integration';
let server: Server | undefined;
afterEach(async () => { await new Promise((r) => server ? server.close(r) : r(undefined)); server = undefined; });

/** A GitHub whose repository o/r has a default branch, no rules and no workflows; `refuseRepo`: its GET is refused. */
async function github(o: { refuseRepo?: boolean }): Promise<string> {
  server = createServer((req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/graphql') {
      return send(200, { data: { repository: null }, errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequests'], message: REFUSED }] });
    }
    if (url === '/repos/o/r') {
      return o.refuseRepo ? send(403, { message: REFUSED }, { 'x-accepted-github-permissions': 'metadata=read' }) : send(200, { default_branch: 'main' });
    }
    if (url === '/repos/o/r/branches/main') return send(200, { name: 'main', protected: false });
    return send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const reader = (apiUrl: string) => createRepoChecksGitHub({ apiUrl, token: async () => 't', renew: async () => 't' });

describe('repository checks: a read GitHub refuses to the GitHub App (issue #1351)', () => {
  it('the pull requests over GraphQL: names Pull requests (read) and the fix', async () => {
    const err = await reader(await github({})).found('o/r', conditionalAnswers()).catch((e: unknown) => e as Error);
    expect(err.message).toContain(`GitHub answered the pull requests of o/r with: ${REFUSED}`);
    expect(err.message).toContain('the GitHub App needs Pull requests (read)');
    expect(err.message).toMatch(/install it on the repository's owner with this repository/);
  });

  it('the repository over REST: names the permission GitHub asks for', async () => {
    const err = await reader(await github({ refuseRepo: true })).found('o/r', conditionalAnswers()).catch((e: unknown) => e as Error);
    expect(err.message).toContain(`GitHub answered 403 to the checks of o/r: ${REFUSED}`);
    expect(err.message).toContain('the GitHub App needs Metadata (read)');
  });
});
