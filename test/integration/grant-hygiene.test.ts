// The daemon revokes nothing at GitHub when a connection is replaced, and drops a connection quietly (issue
// #597): connecting again leaves the old grant to expire and sends nothing to GitHub's credential revocation —
// GitHub's leak report, which ended the new connection too and emailed the owner a security notice. Stop working
// through GitHub deletes the access token through the app token API only when the runtime gives the client
// secret; with none it sends nothing. A connection the runtime cannot open (another HOPPER_TOKEN_KEY) is no
// ended connection: its source says to give the key back, and nothing marks it expired, so no screen asks to
// connect again. The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: grant hygiene in the running hopper
//   Scenario: connecting GitHub again over a live connection revokes nothing, and the new one stays connected
//   Scenario: Stop working through GitHub with the client secret deletes the access token alone, then forgets it
//   Scenario: Stop working through GitHub with no client secret sends nothing to GitHub, and forgets it
//   Scenario: a connection sealed under another key pauses its source with what to do, and is not expired
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus, SourceStatus } from '../../src/domain/types.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const SECRET = 'gh-client-secret';

async function forge() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', clientSecret: SECRET, tokenLifetimeS: 8 * 3600 });
  cleanups.push(() => github.close());
  return github;
}

async function start(github: FakeForge, env: Record<string, string> = {}, secrets: Record<string, string> = {}) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor: 'scripted' } }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test', ...env },
    secrets: { ...secrets },
  });
  apps.push(app);
  return app;
}

const account = async (app: TestApp) =>
  (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts.find((a) => a.provider === 'github')!;
const sourceOf = async (app: TestApp) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github-account');

/** What the hopper sent to GitHub's revocation or token APIs. */
const revocations = (github: FakeForge) => github.requests.filter((r) => r.path.endsWith('/credentials/revoke') || r.path.includes('/applications/'));

/** Connect GitHub from Sources and approve the device code; resolves with the new access token once connected. */
async function connect(app: TestApp, github: FakeForge, token: string): Promise<string> {
  const before = new Set(github.tokens.keys());
  expect((await app.ui('/ui/api/connected-accounts', { action: 'connect', provider: 'github' }, { token })).status).toBe(200);
  await waitFor(async () => (await account(app)).state === 'waiting', { what: 'the device code' });
  github.approve('octo-user');
  await waitFor(async () => (await account(app)).state === 'connected' && [...github.tokens.keys()].some((t) => !before.has(t)), { what: 'github connected' });
  return [...github.tokens.keys()].find((t) => !before.has(t))!;
}

describe('grant hygiene in the running hopper (#514, #597)', () => {
  it('connecting GitHub again over a live connection revokes nothing, and the new one stays connected', async () => {
    const github = await forge();
    const app = await start(github, {}, { HOPPER_GITHUB_CLIENT_SECRET: SECRET });
    const token = await app.login();
    const first = await connect(app, github, token);
    const second = await connect(app, github, token);

    expect(revocations(github)).toEqual([]);
    expect(github.tokens.has(first)).toBe(true); // left to expire
    expect(github.tokens.has(second)).toBe(true);
    expect(await account(app)).toMatchObject({ state: 'connected', account: 'octo-user' });
  });

  it('Stop working through GitHub with the client secret deletes the access token alone, then forgets it', async () => {
    const github = await forge();
    const app = await start(github, {}, { HOPPER_GITHUB_CLIENT_SECRET: SECRET });
    const token = await app.login();
    const access = await connect(app, github, token);

    const r = await app.ui('/ui/api/connected-accounts', { action: 'disconnect', provider: 'github' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'not-connected' });
    expect(github.deleted).toEqual([access]);
    expect(github.revoked).toEqual([]);
    expect(revocations(github).map((q) => `${q.method} ${q.path}`)).toEqual(['DELETE /api/v3/applications/gh-client-id/token']);
  });

  it('Stop working through GitHub with no client secret sends nothing to GitHub, and forgets it', async () => {
    const github = await forge();
    const app = await start(github);
    const token = await app.login();
    const access = await connect(app, github, token);

    const r = await app.ui('/ui/api/connected-accounts', { action: 'disconnect', provider: 'github' }, { token });
    expect(r.body).toMatchObject({ state: 'not-connected' });
    expect(revocations(github)).toEqual([]);
    expect(github.tokens.has(access)).toBe(true); // it expires by itself
  });

  it('a connection sealed under another key pauses its source with what to do, and is not expired', async () => {
    const github = await forge();
    const app = await start(github, { HOPPER_TOKEN_KEY: randomBytes(32).toString('hex') });
    const pair = github.mint('octo-user');
    const other = createTokenBox(randomBytes(32).toString('hex'));
    app.user().store.connectedAccounts.put({
      provider: 'github', account: 'octo-user', subject: '1', connectedAt: '2026-10-08T00:00:00.000Z', grantedBy: 'device',
      accessToken: other.seal(pair.accessToken), refreshToken: other.seal(pair.refreshToken), expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await app.user().sources.syncNow('github-account').catch(() => undefined);
    expect(await account(app)).toMatchObject({ state: 'unreadable', account: 'octo-user', error: expect.stringMatching(/HOPPER_TOKEN_KEY_PREVIOUS/) });
    await waitFor(async () => /HOPPER_TOKEN_KEY_PREVIOUS/.test(String((await sourceOf(app))?.detail.paused)), { what: 'the source to say what to do' });
    const source = await sourceOf(app);
    expect(source?.detail.expired).toBeUndefined();
    expect(String(source?.detail.paused)).not.toMatch(/Connect GitHub/);
    expect(github.revoked).toEqual([]);
  });
});
