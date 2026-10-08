// The connected GitHub account is the one way the hopper reads GitHub as the user (issue #359): with
// no connection, or one whose sign-in expired, nothing is read and Sources asks for a sign-in again.
// Nothing falls back to another credential. Real daemon, the in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub, githubSource } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins: { jobSources: [githubSource({ executor: 'scripted' })] } });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);

describe('the GitHub connection', () => {
  it('an expired connection reads nothing and asks for a sign-in again', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    connectGitHub(a, [REPO], { expiresAt: '2026-01-01T00:00:00.000Z' });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeUndefined();
    expect(gh.calls.filter((c) => c.method === 'listOpenIssues')).toEqual([]);
    const status = (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github');
    expect(status.detail.paused).toBe("GitHub's sign-in expired: Sources → Connect GitHub again");
    const accounts = (await a.api('GET', '/api/connected-accounts')).body.accounts;
    expect(accounts).toEqual([expect.objectContaining({ provider: 'github', state: 'expired', account: 'owner' })]);
  });

  it('with no connection nothing is read, and Sources says GitHub is not connected', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    a.user().store.connectedAccounts.delete('github');
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeUndefined();
    expect(gh.calls).toEqual([]);
    const status = (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github');
    expect(status.detail.paused).toBe('GitHub is not connected: Sources → Connect GitHub');
  });
});
