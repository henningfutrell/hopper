// Issue #2774: a read of the installations has one job: to show every repository the person can choose. Each read lists
// every repository the app reaches, across every installation, grouped by owner with the owner's picture: one installed
// before a restart, one added to an installation since the last read, and a new installation since the last read. A read
// chooses nothing: the job repositories stay as the person chose them. The daemon, store and HTTP edge are real; GitHub is
// a fake on loopback (test/support/fake-forges.ts).
//
// Feature: every repository the app reaches, ready to choose
//   Scenario: the first read after a restart, with an installation that was there before
//     Given the app installed on the account and on an organization with three repositories
//     And the daemon read the installations, then started again on the same database
//     When the person presses Refresh
//     Then every repository of both installations is listed, each owner with its picture
//     And the job repositories did not change
//   Scenario: a repository added to an installation between two reads
//   Scenario: a new installation between two reads
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

type Connected = Extract<ConnectedAccountStatus, { state: 'connected' }>;
const CHOSEN = ['octo-org/tools'];

async function startOn(dbPath: string, github: FakeForge, connect: boolean) {
  const app = await startTestApp({
    dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (connect) connectGitHub(app, CHOSEN);
  return { app, token: await app.login() };
}

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.installedOn = ['owner', 'octo-org'];
  github.chosenRepos = { owner: ['owner/notes'], 'octo-org': ['octo-org/tools', 'octo-org/site', 'octo-org/api'] };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return { github, db, ...(await startOn(db.dbPath, github, true)) };
}

const account = async (app: TestApp): Promise<Connected> => {
  const a = (await app.api<{ accounts: ConnectedAccountStatus[] }>('GET', '/api/connected-accounts')).body.accounts.find((x) => x.provider === 'github')!;
  expect(a.state).toBe('connected');
  return a as Connected;
};

/** Refresh, then the account once its installations were read after `since`. */
async function refreshed(app: TestApp, token: string, since = ''): Promise<Connected> {
  const r = await app.ui<ConnectedAccountStatus>('/ui/api/connected-accounts/refresh', { provider: 'github' }, { token });
  expect(r.status).toBe(200);
  let a: Connected | undefined;
  await expect.poll(async () => {
    a = await account(app);
    return a.installationsCheckedAt !== undefined && a.installationsCheckedAt > since && !a.installationsReading;
  }, { timeout: 10_000 }).toBe(true);
  return a!;
}

/** Each owner, its picture and its repositories, as the read lists them. */
const listed = (a: Connected) => a.installations!.map((i) => ({ account: i.account, avatarUrl: i.avatarUrl, repositories: [...i.repositories].sort() }));
const avatar = (github: FakeForge, login: string) => `${github.url}/avatars/${login}`;

describe('every repository the app reaches, ready to choose (issue #2774)', () => {
  it('the first read after a restart lists an installation that was there before, and chooses nothing', async () => {
    const { app, github, db, token } = await start();
    const read = await refreshed(app, token);
    await app.stop();
    const next = await startOn(db.dbPath, github, false);
    const after = await refreshed(next.app, next.token, read.installationsCheckedAt);
    expect(listed(after)).toEqual([
      { account: 'owner', avatarUrl: avatar(github, 'owner'), repositories: ['owner/notes'] },
      { account: 'octo-org', avatarUrl: avatar(github, 'octo-org'), repositories: ['octo-org/api', 'octo-org/site', 'octo-org/tools'] },
    ]);
    expect(after.jobRepositories).toEqual(CHOSEN);
  });

  it('a repository added to an installation between two reads is listed at the next read, and chooses nothing', async () => {
    const { app, github, token } = await start();
    const first = await refreshed(app, token);
    github.chosenRepos = { ...github.chosenRepos, 'octo-org': [...github.chosenRepos!['octo-org']!, 'octo-org/new'] };
    const next = await refreshed(app, token, first.installationsCheckedAt);
    expect(listed(next).find((i) => i.account === 'octo-org')?.repositories).toEqual(['octo-org/api', 'octo-org/new', 'octo-org/site', 'octo-org/tools']);
    expect(next.jobRepositories).toEqual(CHOSEN);
  });

  it('a new installation between two reads is listed at the next read, with its owner\'s picture, and chooses nothing', async () => {
    const { app, github, token } = await start();
    const first = await refreshed(app, token);
    github.installedOn = [...github.installedOn!, 'acme'];
    github.chosenRepos = { ...github.chosenRepos, acme: ['acme/web', 'acme/db'] };
    const next = await refreshed(app, token, first.installationsCheckedAt);
    expect(listed(next).find((i) => i.account === 'acme')).toEqual({ account: 'acme', avatarUrl: avatar(github, 'acme'), repositories: ['acme/db', 'acme/web'] });
    expect(next.jobRepositories).toEqual(CHOSEN);
  });
});
