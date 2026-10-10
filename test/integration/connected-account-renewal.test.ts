// A connected GitHub account keeps working past its token's expiry (issue #358). GitHub App user tokens
// expire after 8 hours and come with a refresh token (valid 6 months); the hopper keeps both, renews the
// token ahead of its expiry and on a 401, and keeps the new pair. A refresh token GitHub refuses ends the
// sign-in: the account reads as expired — never as connected — its source says so, and the owner is told
// (`connected_account.expired`, which the notifiers send). The daemon, store and HTTP edge are real;
// GitHub is a fake on loopback (test/support/fake-forges.ts) granting tokens that expire.
//
// Feature: a connected GitHub account renews its token
//   Scenario: renewed ahead of expiry, the new pair kept across a restart
//     Given GitHub connected through the device flow, with tokens that expire
//     When the token is within the renewal window of its expiry
//     Then the hopper trades the refresh token for a new pair, without the client secret
//     And after a restart the source pulls with the renewed token
//   Scenario: renewed on a 401
//     Given GitHub connected, its token not near expiry
//     When GitHub refuses the token
//     Then the hopper renews it and the call goes through
//   Scenario: a refused refresh token ends the sign-in
//     When GitHub refuses both the token and its refresh token
//     Then the account reads as expired with why, its source says sign in again, and connected_account.expired is recorded
//   Scenario: connecting again after an expired sign-in reads as connected
//   Scenario: a running job keeps GitHub access across a renewal (issue #441)
//     Given a job of the connected account running on this machine
//     When the token is renewed, and GitHub refuses the one the job started with
//     Then the job's credential file on its machine holds the renewed token, and its variables point there
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { ConnectedAccountStatus, DomainEvent, Job, SourceStatus } from '../../src/domain/types.ts';
import { localShell } from '../../src/executors/machine-shell.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const SLEEP = '{"op":"sleep","ms":60000}';
/** Renewed when an hour or less is left (RENEW_AHEAD_MS): a token of an hour and 3 s is due 3 s after it is granted. */
const DUE_SOON_S = 3600 + 3;
const EIGHT_HOURS_S = 8 * 3600;
const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function forge(tokenLifetimeS: number, issues: Parameters<typeof createFakeGitHub>[0]['issues'] = []) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', issues, tokenLifetimeS });
  cleanups.push(() => github.close());
  return github;
}

function database() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return db.dbPath;
}

async function start(github: FakeForge, dbPath: string, o: { executor?: string; executors?: Executor[] } = {}) {
  const app = await startTestApp({
    dbPath,
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor: o.executor ?? 'scripted' } }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    ...(o.executors ? { seams: { executors: o.executors } } : {}),
  });
  apps.push(app);
  return app;
}

const account = async (app: TestApp) =>
  (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts.find((a) => a.provider === 'github')!;
const sourceOf = async (app: TestApp) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github-account');
const jobs = async (app: TestApp) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const events = async (app: TestApp) => (await app.api<{ events: DomainEvent[] }>('GET', '/api/events?limit=1000')).body.events;
const refreshes = (github: FakeForge) => github.requests.filter((r) => r.path === '/login/oauth/access_token' && r.body.grant_type === 'refresh_token');

async function connect(app: TestApp, github: FakeForge, token: string, repos: string[] = ['octo-user/tools']) {
  expect((await app.ui('/ui/api/connected-accounts', { action: 'connect', provider: 'github' }, { token })).status).toBe(200);
  github.approve('octo-user');
  await waitFor(async () => (await account(app)).state === 'connected', { what: 'github connected' });
  await app.ui('/ui/api/connected-accounts', { action: 'choose', provider: 'github', repositories: repos }, { token });
}

describe('a connected GitHub account renews its token (#358)', () => {
  it('renews ahead of expiry with the refresh token, and keeps the new pair across a restart', async () => {
    const github = await forge(DUE_SOON_S, [{ repo: 'octo-user/tools', number: 7, title: 'x', body: SLEEP, author: 'octo-user', labels: ['hopper'] }]);
    const dbPath = database();
    const app = await start(github, dbPath);
    await connect(app, github, await app.login());
    const [first] = [...github.tokens.keys()];
    const [firstRefresh] = [...github.refreshTokens.keys()];

    await waitFor(async () => { await account(app); return refreshes(github).length > 0; }, { what: 'a renewal', timeoutMs: 15_000 });
    const renewal = refreshes(github)[0]!;
    expect(renewal.body).toMatchObject({ client_id: 'gh-client-id', grant_type: 'refresh_token', refresh_token: firstRefresh });
    // A device flow grant renews without the client secret, which this hopper has none of.
    expect(renewal.body).not.toHaveProperty('client_secret');
    expect(await account(app)).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(JSON.stringify(await account(app))).not.toMatch(/gh[or]_/); // facts only, never a token

    // GitHub stops taking the first token; a restart reads the renewed pair from the store.
    github.tokens.delete(first!);
    await app.stop();
    apps.splice(apps.indexOf(app), 1);
    const again = await start(github, dbPath);
    github.issues.push({ repo: 'octo-user/tools', number: 8, title: 'y', body: SLEEP, author: 'octo-user', labels: ['hopper'] });
    await waitFor(async () => (await jobs(again)).some((j) => j.source?.number === 8), { what: 'the issue to become a job after the restart', timeoutMs: 15_000 });
    expect(await account(again)).toMatchObject({ state: 'connected' });
    const used = github.requests.filter((r) => r.path.startsWith('/api/v3/repos/')).at(-1)!;
    expect(used.auth).not.toBe(`token ${first}`);
  });

  it('renews on a 401, and the call goes through', async () => {
    const github = await forge(EIGHT_HOURS_S, [{ repo: 'octo-user/tools', number: 7, title: 'x', body: SLEEP, author: 'octo-user', labels: ['hopper'] }]);
    const app = await start(github, database());
    await connect(app, github, await app.login(), []);
    expect(refreshes(github)).toHaveLength(0);
    // GitHub refuses the token long before its expiry (revoked, say): the refresh token still works.
    github.tokens.clear();
    await app.ui('/ui/api/connected-accounts', { action: 'choose', provider: 'github', repositories: ['octo-user/tools'] }, { token: await app.login() });
    await waitFor(async () => (await jobs(app)).some((j) => j.source?.number === 7), { what: 'the issue to become a job', timeoutMs: 15_000 });
    expect(refreshes(github)).toHaveLength(1);
    expect(await account(app)).toMatchObject({ state: 'connected' });
  });

  it('reads as expired once GitHub refuses the refresh token, says so on its source, and records connected_account.expired', async () => {
    const github = await forge(EIGHT_HOURS_S);
    const app = await start(github, database());
    const token = await app.login();
    await connect(app, github, token);
    await waitFor(async () => (await sourceOf(app))?.state === 'ok', { what: 'the source to sync' });

    github.tokens.clear();
    github.refreshTokens.clear();
    await app.user().sources.syncNow('github-account');
    await waitFor(async () => (await account(app)).state === 'expired', { what: 'the account to read as expired' });
    const expired = await account(app);
    expect(expired).toMatchObject({ provider: 'github', state: 'expired', account: 'octo-user', error: expect.stringMatching(/refresh token/) });
    await waitFor(async () => (await sourceOf(app))?.detail.paused === 'GitHub\'s sign-in expired: Sources → Connect GitHub again', { what: 'the source to say so' });
    const told = (await events(app)).filter((e) => e.type === 'connected_account.expired');
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toMatchObject({ provider: 'github', account: 'octo-user', reason: expect.stringMatching(/refresh token/) });

    // Told once, not at every sync.
    await app.user().sources.syncNow('github-account');
    expect((await events(app)).filter((e) => e.type === 'connected_account.expired')).toHaveLength(1);

    // Connecting again is a live sign-in.
    await connect(app, github, token);
    expect(await account(app)).toMatchObject({ state: 'connected', account: 'octo-user' });
    await waitFor(async () => (await sourceOf(app))?.detail.paused === undefined, { what: 'the source to resume' });
  });
});

describe('a running job keeps GitHub access across a renewal (#441)', () => {
  it('rewrites the job\'s credential file on its machine with the renewed token', async () => {
    const work = mkdtempSync(join(tmpdir(), 'jh-441-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    mkdirSync(work, { recursive: true });
    let env: Record<string, string> | undefined;
    // A job that runs until it is stopped, on this machine, through its real shell.
    const holder: Executor = {
      name: 'holder', idempotent: false, validate: () => null,
      machineShell: () => localShell(),
      async run(ctx) {
        env = { ...(await ctx.credentials!(join(work, '.hopper-scratch', ctx.job.id))) };
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        return { kind: 'failed', error: 'stopped' };
      },
    };
    const github = await forge(EIGHT_HOURS_S, [{ repo: 'octo-user/tools', number: 7, title: 'x', body: 'Do it.', author: 'octo-user', labels: ['hopper'] }]);
    const app = await start(github, database(), { executor: 'holder', executors: [holder] });
    await connect(app, github, await app.login());
    await waitFor(async () => env !== undefined, { what: 'the job to start', timeoutMs: 15_000 });

    const job = (await jobs(app))[0]!;
    const dir = join(work, '.hopper-scratch', job.id, 'credentials');
    // Beside it, the GitHub proxy's files (issue #563): the job's proxy token and hopper-gh, never a GitHub token; and
    // hopper-skill (issue #582) and hopper-artifact (issue #624).
    expect(env).toEqual({ GH_CONFIG_DIR: join(dir, 'gh'), HOPPER_TOKEN_FILE: join(dir, 'hopper', 'token'), HOPPER_GH: join(dir, 'hopper', 'gh'), HOPPER_SKILL: join(dir, 'hopper', 'skill'), HOPPER_ARTIFACT: join(dir, 'hopper', 'artifact'), HOPPER_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    const hosts = () => readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8');
    const started = /oauth_token: "([^"]+)"/.exec(hosts())![1]!;
    expect(github.tokens.has(started)).toBe(true);

    const renewed = await app.user().connectedAccounts.renew('github', started);
    expect(github.tokens.has(started)).toBe(false); // GitHub refuses the token the job started with
    await waitFor(async () => hosts().includes(renewed), { what: 'the renewed token on the job\'s machine' });
    expect(hosts()).not.toContain(started);
    expect(github.tokens.has(renewed)).toBe(true);
    expect(JSON.stringify(await jobs(app))).not.toMatch(/gh[or]_/); // never on the job
  });
});
