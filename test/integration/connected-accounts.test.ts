// A user connects their GitHub to the hopper (issue #214): GitHub's device flow through
// the hopper's GitHub App — its public client id and no secret — and from then on that user's intake
// comes from the account they connected, and their jobs act through it (as the user, with the app
// marked on what they do). Signing in with GitHub makes the same connection (sign-in-device.test.ts);
// here a user signed in another way connects from Sources. The daemon, store and HTTP edge are real;
// GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: connect GitHub as a source to work from
//   Scenario: connect GitHub, and its issues become jobs
//     Given a hopper whose GitHub is reachable and whose OAuth app has a client id
//     And its github-account job source, which says GitHub is not connected
//     When an admin connects GitHub
//     Then the answer is the device code and where to enter it, asked for with the client id alone
//     When the GitHub user approves the code
//     Then GitHub reads as connected, as that account, through the hopper's app, where the app is installed and the repositories it reaches there
//     When the admin chooses the repository jobs may use
//     Then an issue labelled hopper by that account there becomes a job, claimed through the account's token
//   Scenario: job repositories (issue #321)
//     Given GitHub connected, and no repository chosen
//     Then its source says no repository is chosen, and no issue becomes a job
//     When one repository is chosen
//     Then its issues become jobs, and an issue of a repository not chosen does not
//     And the choice is changed without disconnecting, and outlives a disconnect
//   Scenario: the app installed on two accounts, one with chosen repositories: each with the repositories it reaches, every page of them
//   Scenario: GitHub cannot say where the app is installed: the status says why and where to see it, never that it is not installed
//   Scenario: a job of the connected account runs with no GitHub token where its machine keeps no credential files (issue #652)
//   Scenario: disconnect
//     Then GitHub reads as not connected, its source says so, and no issue becomes a job
//   Scenario: a denied code fails, and connecting again starts over
//   Scenario: each user connects their own
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { ConnectedAccountStatus, Job, SourceStatus } from '../../src/domain/types.ts';
import type { AppSeams } from '../../src/main.ts';
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

async function forges(issues: { github?: Parameters<typeof createFakeGitHub>[0]['issues'] } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', issues: issues.github ?? [] });
  cleanups.push(() => github.close());
  return { github };
}

async function start(f: { github: FakeForge }, o: { executor?: string; seams?: AppSeams } = {}) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const executor = o.executor ?? 'scripted';
  const app = await startTestApp({
    dbPath: db.dbPath,
    ...(o.seams ? { seams: o.seams } : {}),
    // The scripted executor runs the op on the issue body's first line: a job that keeps its claim.
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor } }] },
    env: { HOPPER_GITHUB_URL: f.github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  return app;
}

type Provider = ConnectedAccountStatus['provider'];
const accounts = async (app: TestApp) => (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts;
const account = async (app: TestApp, provider: Provider) => (await accounts(app)).find((a) => a.provider === provider)!;
const act = (app: TestApp, token: string, action: 'connect' | 'cancel' | 'disconnect', provider: Provider) =>
  app.ui<ConnectedAccountStatus>('/ui/api/connected-accounts', { action, provider }, { token });
const choose = (app: TestApp, token: string, repositories: string[]) =>
  app.ui<ConnectedAccountStatus>('/ui/api/connected-accounts', { action: 'choose', provider: 'github', repositories }, { token });
const NO_REPOSITORIES = 'no repositories chosen for jobs: Sources → GitHub account → choose them';
const sourceOf = async (app: TestApp, name: string) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === name);
const jobs = async (app: TestApp) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;

async function connect(app: TestApp, forge: FakeForge, provider: Provider, login: string, token: string) {
  const started = await act(app, token, 'connect', provider);
  expect(started.status).toBe(200);
  forge.approve(login);
  await waitFor(async () => (await account(app, provider)).state === 'connected', { what: `${provider} connected` });
  return started.body;
}

describe('a user connects their own GitHub', () => {
  it('connects through the OAuth app, with the client id and no secret, and its issues become jobs', async () => {
    const f = await forges({ github: [{ repo: 'octo-user/tools', number: 7, title: 'Add a flag', body: SLEEP, author: 'octo-user', labels: ['hopper'] }] });
    const app = await start(f);
    expect(await account(app, 'github')).toEqual({ provider: 'github', state: 'not-connected', via: 'the hopper\'s app' });
    // Not connected is said out loud where the sources are.
    await waitFor(async () => (await sourceOf(app, 'github-account'))?.detail.paused === 'GitHub is not connected: Sources → Connect GitHub', { what: 'github-account to say so' });
    // A mutation: a UI session, never a bare request.
    expect((await app.ui('/ui/api/connected-accounts', { action: 'connect', provider: 'github' })).status).toBe(403);

    const token = await app.login();
    const started = await act(app, token, 'connect', 'github');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ provider: 'github', state: 'waiting', userCode: 'GH1-CODE', verificationUri: `${f.github.url}/login/device` });
    const asked = f.github.requests.find((r) => r.path === '/login/device/code')!;
    expect(asked.body).toMatchObject({ client_id: 'gh-client-id' });
    expect(asked.body).not.toHaveProperty('client_secret');
    expect(asked.body).not.toHaveProperty('scope'); // a GitHub App asks for no scopes: its permissions are the app's
    // A second connect while one waits answers the same code.
    expect((await act(app, token, 'connect', 'github')).body).toMatchObject({ userCode: 'GH1-CODE' });

    f.github.approve('octo-user');
    await waitFor(async () => (await account(app, 'github')).state === 'connected', { what: 'github connected' });
    const connected = await account(app, 'github');
    expect(connected).toMatchObject({
      provider: 'github', state: 'connected', account: 'octo-user', via: 'the hopper\'s app',
      // The app reaches only the repositories it is installed on: where, and which repositories there.
      installUrl: `${f.github.url}/apps/hopper-test/installations/new`,
      configUrl: `${f.github.url}/settings/installations`,
      installations: [{
        account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/tools'], settingsUrl: `${f.github.url}/settings/installations/1`,
        // What the installation grants there, as GitHub says it (issue #352).
        permissions: { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
      }],
    });
    expect(JSON.stringify(await accounts(app))).not.toMatch(/gho_/); // facts only, never the token
    expect((await choose(app, token, ['octo-user/tools'])).body).toMatchObject({ state: 'connected', jobRepositories: ['octo-user/tools'] });

    const job = await waitFor(async () => (await jobs(app)).find((j) => j.source?.key === `${f.github.url}/octo-user/tools/issues/7`), { what: 'the issue to become a job' });
    expect(job.source).toMatchObject({ source: 'github-account', repo: 'octo-user/tools', number: 7 });
    // Read and labelled through the connected account's own token.
    await waitFor(async () => f.github.issues[0]!.labels.includes('hopper:claimed'), { what: 'the claim label' });
    const writes = f.github.requests.filter((r) => r.path.startsWith('/api/v3/repos/'));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.auth).toMatch(/^token gho_octo-user_/);
    const s = await sourceOf(app, 'github-account');
    expect(s?.detail.account).toMatchObject({ service: 'github', identity: 'octo-user', detail: { via: 'the hopper\'s app' } });
  });

  it('says, for each account the app is installed on, the repositories it reaches there — every page of them (#253)', async () => {
    const f = await forges({ github: [{ repo: 'octo-user/tools', number: 7, title: 'x', body: SLEEP, author: 'octo-user', labels: [] }] });
    const chosen = Array.from({ length: 130 }, (_, i) => `octo-org/repo-${String(i).padStart(3, '0')}`);
    f.github.installedOn = ['octo-user', 'octo-org'];
    f.github.chosenRepos = { 'octo-org': chosen };
    const app = await start(f);
    await connect(app, f.github, 'github', 'octo-user', await app.login());
    const connected = await account(app, 'github');
    const permissions = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };
    expect(connected.state === 'connected' && connected.installations).toEqual([
      { account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/tools'], settingsUrl: `${f.github.url}/settings/installations/1`, permissions },
      { account: 'octo-org', repositorySelection: 'selected', repositories: chosen, settingsUrl: `${f.github.url}/settings/installations/2`, permissions },
    ]);
  });

  it('says why, and where to see the installs, when GitHub cannot say where the app is installed (#263)', async () => {
    const f = await forges();
    const app = await start(f);
    await connect(app, f.github, 'github', 'octo-user', await app.login());
    f.github.installationsDown = true;
    const connected = await account(app, 'github');
    expect(connected).toMatchObject({ state: 'connected', account: 'octo-user', configUrl: `${f.github.url}/settings/installations` });
    expect(connected).not.toHaveProperty('installations');
    expect(connected.state === 'connected' && connected.installationsError).toMatch(/^GitHub could not say where the app is installed: .+/);
    f.github.installationsDown = false;
    const again = await account(app, 'github');
    expect(again).not.toHaveProperty('installationsError');
    expect(again.state === 'connected' && again.installations).toHaveLength(1);
  });

  it('takes no job until repositories are chosen, then only from the chosen ones, changed without disconnecting (#321)', async () => {
    const f = await forges({ github: [
      { repo: 'octo-user/tools', number: 7, title: 'x', body: SLEEP, author: 'octo-user', labels: ['hopper'] },
      { repo: 'octo-user/other', number: 3, title: 'y', body: SLEEP, author: 'octo-user', labels: ['hopper'] },
    ] });
    const app = await start(f);
    const token = await app.login();
    await connect(app, f.github, 'github', 'octo-user', token);
    expect(await account(app, 'github')).toMatchObject({ state: 'connected', jobRepositories: [] });
    await waitFor(async () => (await sourceOf(app, 'github-account'))?.detail.paused === NO_REPOSITORIES, { what: 'the source to say no repository is chosen' });
    await app.user().sources.syncNow('github-account');
    expect(await jobs(app)).toEqual([]);
    expect(f.github.requests.some((r) => r.path.endsWith('/search/issues'))).toBe(false);

    // A mutation: a UI session, never a bare request; each one an owner/repo.
    expect((await app.ui('/ui/api/connected-accounts', { action: 'choose', provider: 'github', repositories: ['octo-user/tools'] })).status).toBe(403);
    expect((await choose(app, token, ['not a repo'])).status).toBe(400);

    const chosen = await choose(app, token, ['octo-user/tools', 'octo-user/tools']);
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ state: 'connected', jobRepositories: ['octo-user/tools'] });
    await waitFor(async () => (await jobs(app)).some((j) => j.source?.repo === 'octo-user/tools'), { what: 'the chosen repository\'s issue to become a job' });
    await waitFor(async () => (await sourceOf(app, 'github-account'))?.detail.paused === undefined, { what: 'the source to resume' });
    await app.user().sources.syncNow('github-account');
    expect((await jobs(app)).map((j) => j.source?.repo)).toEqual(['octo-user/tools']);

    // Changed later, still connected: the next sync lists the new choice.
    await choose(app, token, ['octo-user/tools', 'octo-user/other']);
    await waitFor(async () => (await jobs(app)).some((j) => j.source?.repo === 'octo-user/other'), { what: 'the newly chosen repository\'s issue to become a job' });

    // The choice is the user's, not the connection's: a disconnect keeps it.
    await act(app, token, 'disconnect', 'github');
    await connect(app, f.github, 'github', 'octo-user', token);
    expect(await account(app, 'github')).toMatchObject({ jobRepositories: ['octo-user/tools', 'octo-user/other'] });
  });

  it('runs a job of the connected account with no GitHub token where its machine keeps no credential files (issue #652), and never stores one on the job', async () => {
    const f = await forges({ github: [{ repo: 'octo-user/tools', number: 9, title: 'x', body: 'Do it.', author: 'octo-user', labels: ['hopper'] }] });
    const seen: Record<string, string>[] = [];
    const recorder: Executor = {
      name: 'recorder', idempotent: false, validate: () => null,
      async run(ctx) { seen.push({ ...(await ctx.credentials?.(`/w/.hopper-scratch/${ctx.job.id}`)) }); return { kind: 'failed', error: 'recorded' }; },
      resume: async () => ({ kind: 'failed', error: 'recorded' }),
    };
    const app = await start(f, { executor: 'recorder', seams: { executors: [recorder] } });
    const token = await app.login();
    await connect(app, f.github, 'github', 'octo-user', token);
    await choose(app, token, ['octo-user/tools']);
    await waitFor(async () => seen.length > 0, { what: 'the job to run' });
    expect(seen[0]).toEqual({});
    const job = (await jobs(app))[0]!;
    expect(JSON.stringify(job)).not.toMatch(/gho_/);
  });

  it('shows not connected once disconnected, says so on its source, and pulls nothing', async () => {
    const f = await forges();
    const app = await start(f);
    const token = await app.login();
    await connect(app, f.github, 'github', 'octo-user', token);
    await choose(app, token, ['octo-user/tools']);
    await waitFor(async () => (await sourceOf(app, 'github-account'))?.state === 'ok', { what: 'the source to sync' });

    f.github.issues.push({ repo: 'octo-user/tools', number: 8, title: 'x', body: SLEEP, author: 'octo-user', labels: ['hopper'] });
    expect((await act(app, token, 'disconnect', 'github')).body).toEqual({ provider: 'github', state: 'not-connected', via: 'the hopper\'s app' });
    expect(await account(app, 'github')).toMatchObject({ state: 'not-connected' });
    await waitFor(async () => (await sourceOf(app, 'github-account'))?.detail.paused !== undefined, { what: 'the source to pause' });
    expect((await sourceOf(app, 'github-account'))?.detail.paused).toBe('GitHub is not connected: Sources → Connect GitHub');
    await app.user().sources.syncNow('github-account');
    expect(await jobs(app)).toEqual([]);
  });

  it('fails a denied code, and connecting again starts over', async () => {
    const f = await forges();
    const app = await start(f);
    const token = await app.login();
    await act(app, token, 'connect', 'github');
    f.github.deny();
    await waitFor(async () => (await account(app, 'github')).state === 'failed', { what: 'github failed' });
    expect(await account(app, 'github')).toMatchObject({ state: 'failed', error: expect.stringMatching(/denied/) });
    expect((await act(app, token, 'connect', 'github')).body).toMatchObject({ state: 'waiting', userCode: 'GH2-CODE' });
    expect((await act(app, token, 'cancel', 'github')).body).toMatchObject({ state: 'not-connected' });
  });

  it('keeps each user\'s connection their own', async () => {
    const f = await forges();
    const app = await start(f);
    const token = await app.login();
    await connect(app, f.github, 'github', 'octo-user', token);
    const other = await app.addUser('second');
    // With several users, every read is a session's own user's.
    const read = async (session: string) =>
      (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts', undefined, { 'x-hopper-session': session })).body.accounts.find((a) => a.provider === 'github');
    expect(await read(token)).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(await read(await app.login(other.id))).toMatchObject({ state: 'not-connected' });
  });
});

