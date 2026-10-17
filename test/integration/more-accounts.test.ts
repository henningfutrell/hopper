// More than one GitHub account per user (issue #1448, design.md "More than one GitHub account"), through the real daemon,
// store and HTTP edge; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: a second GitHub account
//   Scenario: a user adds a second GitHub account with a personal access token; Intake takes the issues of the repositories
//     chosen in each, each through its own account's token, and the second account's source names it
//   Scenario: a repository is a job repository of one account only; an unknown key is not found
//   Scenario: removing the second account removes its source; the first account stays
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus, Job, SourceStatus } from '../../src/domain/types.ts';
import { REMOVED } from '../../src/sources/sync-slots.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const SLEEP = '{"op":"sleep","ms":60000}';
const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const github = await createFakeGitHub({
    clientId: 'gh-client-id',
    issues: [
      { repo: 'ada-home/tools', number: 1, title: 'Home work', body: SLEEP, author: 'ada-home', labels: ['hopper'] },
      { repo: 'acme/api', number: 2, title: 'Work work', body: SLEEP, author: 'ada-work', labels: ['hopper'] },
    ],
  });
  cleanups.push(() => github.close());
  // Two personal access tokens, of two GitHub accounts of one person.
  github.tokens.set('github_pat_home', 'ada-home');
  github.tokens.set('github_pat_work', 'ada-work');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor: 'scripted' } }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id' },
  });
  apps.push(app);
  return { app, github };
}

const post = (app: TestApp, token: string, body: Record<string, unknown>) => app.ui<ConnectedAccountStatus & { error?: string }>('/ui/api/connected-accounts', body, { token });
const accounts = async (app: TestApp) => (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts;
const sources = async (app: TestApp) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources;
const jobs = async (app: TestApp) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const writesTo = (github: FakeForge, repo: string) => github.requests.filter((r) => r.path.startsWith(`/api/v3/repos/${repo}/`));

describe('a second GitHub account', () => {
  it('adds it with a token; Intake takes the issues of each account\'s repositories through that account', async () => {
    const { app, github } = await setup();
    const token = await app.login();
    expect((await post(app, token, { action: 'connect-token', provider: 'github', token: 'github_pat_home' })).body).toMatchObject({ key: 'github', state: 'connected', account: 'ada-home' });
    const added = await post(app, token, { action: 'add-token', provider: 'github', token: 'github_pat_work' });
    expect(added.body).toMatchObject({ provider: 'github', key: 'github-2', state: 'connected', account: 'ada-work', grantedBy: 'token' });
    expect((await accounts(app)).map((a) => [a.key, a.state])).toEqual([['github', 'connected'], ['github-2', 'connected']]);
    expect(JSON.stringify(await accounts(app))).not.toContain('github_pat_');

    expect((await post(app, token, { action: 'choose', provider: 'github', repositories: ['ada-home/tools'] })).body).toMatchObject({ key: 'github', jobRepositories: ['ada-home/tools'] });
    expect((await post(app, token, { action: 'choose', provider: 'github', key: 'github-2', repositories: ['acme/api'] })).body).toMatchObject({ key: 'github-2', jobRepositories: ['acme/api'] });

    // The second account's source, added by the hopper, never written to the plugins config.
    const second = await waitFor(async () => (await sources(app)).find((s) => s.name === 'github-account-2'), { what: 'the second account\'s source' });
    expect(second).toMatchObject({ kind: 'github-account', detail: { accountKey: 'github-2' } });

    const home = await waitFor(async () => (await jobs(app)).find((j) => j.source?.repo === 'ada-home/tools'), { what: 'the first account\'s issue to become a job' });
    const work = await waitFor(async () => (await jobs(app)).find((j) => j.source?.repo === 'acme/api'), { what: 'the second account\'s issue to become a job' });
    expect(home.source).toMatchObject({ source: 'github-account', number: 1 });
    expect(work.source).toMatchObject({ source: 'github-account-2', number: 2 });
    await waitFor(async () => writesTo(github, 'acme/api').length > 0 && writesTo(github, 'ada-home/tools').length > 0, { what: 'both claims' });
    for (const w of writesTo(github, 'acme/api')) expect(w.auth).toBe('token github_pat_work');
    for (const w of writesTo(github, 'ada-home/tools')) expect(w.auth).toBe('token github_pat_home');
  });

  it('keeps a repository to one account, finds no unknown key, and removes the second account with its source', async () => {
    const { app } = await setup();
    const token = await app.login();
    await post(app, token, { action: 'connect-token', provider: 'github', token: 'github_pat_home' });
    await post(app, token, { action: 'add-token', provider: 'github', token: 'github_pat_work' });
    await post(app, token, { action: 'choose', provider: 'github', key: 'github-2', repositories: ['acme/api'] });
    const taken = await post(app, token, { action: 'choose', provider: 'github', repositories: ['acme/api'] });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain('acme/api (github-2)');
    expect((await post(app, token, { action: 'choose', provider: 'github', key: 'github-7', repositories: [] })).status).toBe(404);
    // The same account twice is no second account.
    expect((await post(app, token, { action: 'add-token', provider: 'github', token: 'github_pat_home' })).body).toMatchObject({ state: 'failed', error: expect.stringContaining('connected already') });

    await waitFor(async () => (await sources(app)).some((s) => s.name === 'github-account-2'), { what: 'the second account\'s source' });
    expect((await post(app, token, { action: 'disconnect', provider: 'github', key: 'github-2' })).body).toMatchObject({ key: 'github-2', state: 'not-connected' });
    expect((await accounts(app)).map((a) => a.key)).toEqual(['github']);
    // Its source goes; one with jobs of its own keeps its slot, marked removed, and pulls nothing more (issue #356).
    await waitFor(async () => { const s = (await sources(app)).find((x) => x.name === 'github-account-2'); return !s || s.detail.paused === REMOVED; }, { what: 'its source to go' });
    expect((await accounts(app))[0]).toMatchObject({ key: 'github', state: 'connected', account: 'ada-home' });
  });
});
