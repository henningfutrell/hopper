// Batched GraphQL reads (issue #822): a sync follows the pull requests of its jobs side by side, so the GraphQL reads of
// their issues go to GitHub together, each request carrying the reads of every followed issue. Real daemon, real
// database, the connected account's real adapter against the node:http fake GitHub, which records each request.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
let a: TestApp | undefined;
let fake: FakeGitHubServer | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  await fake?.close();
  cleanup?.();
  a = fake = cleanup = undefined;
});

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;

/**
 * The GraphQL requests the fake saw, each as the issue numbers it read; a repository listing and the in-motion cycle's batch
 * (issue #985, `[pu]0:` aliases) read none by a number variable, nor does the connected account's tagged items search
 * (issue #1141): those are left out.
 */
const graphqlReads = (f: FakeGitHubServer): number[][] => f.state.requests.filter((r) => r.path === '/graphql' && !/[rpu]0: repository\(/.test(String((r.body as { query?: string }).query))).map((r) => {
  const { variables } = r.body as { variables: Record<string, unknown> };
  return Object.entries(variables).filter(([k]) => k === 'number' || /^k\d+$/.test(k)).map(([, v]) => Number(v));
}).filter((numbers) => numbers.length > 0);

describe('batched GraphQL reads in a sync (issue #822)', () => {
  it('a sync that follows three pull requests asks GitHub about the three issues in shared requests', async () => {
    const numbers = [1, 2, 3];
    fake = await createFakeGitHubServer({
      login: 'owner', token: TEST_ACCOUNT_TOKEN,
      installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: numbers.map((number) => (
        { number, title: `Thing ${number}`, author: 'owner', labels: ['hopper'], body: body({ op: 'echo' }) })) }] }],
    });
    const db = tempDbPath();
    cleanup = db.cleanup;
    a = await startTestApp({
      dbPath: db.dbPath, env: fakeGitHubEnv(fake), plugins: { jobSources: [githubSource({ executor: 'scripted' })] },
    });
    connectGitHub(a, [REPO]);
    const issues = fake.state.repos.get(REPO)!.issues;
    a.scripted.ships((job) => {
      const n = Number(job.source?.key?.split('/').pop());
      // Pull request n + 10 closes issue n.
      issues.get(n)!.openPullRequests.push({ url: `https://github.com/${REPO}/pull/${n + 10}`, createdAt: new Date().toISOString(), isDraft: false });
    });
    await a.sync();
    for (const n of numbers) await a.waitForStatus((await jobFor(a, `https://github.com/${REPO}/issues/${n}`)).id, 'finished');
    await waitFor(() => numbers.every((n) => issues.get(n)!.labels.includes('hopper:pr-ready')), { what: 'hopper:pr-ready' });

    fake.state.requests.length = 0;
    await a.sync();
    // Each request reads the three issues, or their three pull requests by number: never one request for each issue.
    const requests = graphqlReads(fake).map((r) => r.map((n) => (n > 10 ? n - 10 : n)).sort());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).toEqual(requests.map(() => numbers));
  });
});
