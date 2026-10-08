// The daemon keeps GitHub's grants tidy (issue #514): Stop working through GitHub revokes the connection's
// grant at GitHub before it forgets it, so the abandoned grant stops counting toward GitHub's ten per user
// and app. A connection the runtime cannot open (another HOPPER_TOKEN_KEY) is no ended connection: its
// source says to give the key back, and nothing marks it expired, so no screen asks to connect again.
// The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: grant hygiene in the running hopper
//   Scenario: Stop working through GitHub revokes the grant, then forgets it
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

async function forge() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', tokenLifetimeS: 8 * 3600 });
  cleanups.push(() => github.close());
  return github;
}

async function start(github: FakeForge, env: Record<string, string> = {}) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor: 'scripted' } }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test', ...env },
  });
  apps.push(app);
  return app;
}

const account = async (app: TestApp) =>
  (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts.find((a) => a.provider === 'github')!;
const sourceOf = async (app: TestApp) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github-account');

describe('grant hygiene in the running hopper (#514)', () => {
  it('Stop working through GitHub revokes the grant at GitHub, then forgets it', async () => {
    const github = await forge();
    const app = await start(github);
    const token = await app.login();
    expect((await app.ui('/ui/api/connected-accounts', { action: 'connect', provider: 'github' }, { token })).status).toBe(200);
    github.approve('octo-user');
    await waitFor(async () => (await account(app)).state === 'connected', { what: 'github connected' });
    const [access] = [...github.tokens.keys()];
    const [refresh] = [...github.refreshTokens.keys()];

    const r = await app.ui('/ui/api/connected-accounts', { action: 'disconnect', provider: 'github' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'not-connected' });
    expect(github.revoked).toEqual([[access, refresh]]);
    expect(github.tokens.size).toBe(0);
    expect(github.refreshTokens.size).toBe(0);
    const revoke = github.requests.find((q) => q.path === '/api/v3/credentials/revoke')!;
    expect(revoke.auth).toBe(''); // GitHub takes it unauthenticated
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
