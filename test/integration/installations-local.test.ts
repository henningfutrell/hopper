// Issue #1250 part 2: Sources shows where the hopper's GitHub App is installed, and the repositories it reaches there, from
// the hopper's database: a load of GET /api/connected-accounts never reads GitHub. GitHub is read in the background, on
// Refresh, on the schedule, or when the account is connected, with conditional requests: an answer GitHub says is unchanged
// (304) costs nothing. What was read, and each answer's ETag, survive a restart. The daemon, store and HTTP edge are real;
// GitHub is a fake on loopback that counts each request (test/support/fake-forges.ts).
//
// Feature: the app's installations from the hopper's database
//   Scenario: loading the connected account reads no GitHub
//     Given a connected account whose installations were never read
//     When the person loads the connected account again and again
//     Then GitHub gets no request, and the installations are not read yet
//   Scenario: Refresh reads them once, in the background
//     When the person presses Refresh
//     Then the answer comes at once, and the installations are read once
//     And loads after it read no GitHub
//   Scenario: unchanged installations take the 304 path
//     When the person presses Refresh again and nothing changed on GitHub
//     Then each request is answered 304
//   Scenario: a failed read keeps what was read before, with why
//   Scenario: what was read survives a restart
//     When the daemon starts again on the same database
//     Then the connected account shows what was read, when, with no GitHub request
//     And a Refresh after it still takes the 304 path
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge, type ForgeRequest } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

type Connected = Extract<ConnectedAccountStatus, { state: 'connected' }>;

async function startOn(dbPath: string, github: FakeForge, connect: boolean) {
  const app = await startTestApp({
    dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (connect) connectGitHub(app, ['octo-org/tools']);
  return { app, token: await app.login() };
}

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.installedOn = ['owner', 'octo-org'];
  github.chosenRepos = { owner: ['owner/notes'], 'octo-org': ['octo-org/tools', 'octo-org/site'] };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return { github, db, ...(await startOn(db.dbPath, github, true)) };
}

/** The requests GitHub got about where the app is installed. */
const installs = (requests: ForgeRequest[]): ForgeRequest[] => requests.filter((r) => r.path.startsWith('/api/v3/user/installations'));
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

const READ = [
  { account: 'owner', repositorySelection: 'selected', repositories: ['owner/notes'] },
  { account: 'octo-org', repositorySelection: 'selected', repositories: ['octo-org/tools', 'octo-org/site'] },
];

describe('the app\'s installations from the hopper\'s database', () => {
  it('loads of the connected account read no GitHub; the installations are not read yet', async () => {
    const { app, github } = await start();
    for (let i = 0; i < 5; i++) {
      const a = await account(app);
      expect(a).not.toHaveProperty('installations');
      expect(a).not.toHaveProperty('installationsError');
      expect(a).not.toHaveProperty('installationsCheckedAt');
    }
    expect(installs(github.requests)).toEqual([]);
  });

  it('Refresh answers at once and reads them once; loads after it read no GitHub', async () => {
    const { app, github, token } = await start();
    const a = await refreshed(app, token);
    expect(a.installations).toMatchObject(READ);
    expect(a).not.toHaveProperty('installationsError');
    // One list of the installations, and one list of the repositories of each.
    expect(installs(github.requests).map((r) => r.path)).toEqual([
      '/api/v3/user/installations', '/api/v3/user/installations/1/repositories', '/api/v3/user/installations/2/repositories',
    ]);
    const seen = github.requests.length;
    for (let i = 0; i < 5; i++) await account(app);
    expect(installs(github.requests.slice(seen))).toEqual([]);
  });

  it('a Refresh of unchanged installations is answered 304 throughout', async () => {
    const { app, github, token } = await start();
    const first = await refreshed(app, token);
    const from = github.requests.length;
    const again = await refreshed(app, token, first.installationsCheckedAt);
    expect(again.installations).toMatchObject(READ);
    const asked = installs(github.requests.slice(from));
    expect(asked).toHaveLength(3);
    expect(asked.filter((r) => !r.notModified).map((r) => r.path)).toEqual([]);
  });

  it('a failed read keeps what was read before, with why, and a later read clears it', async () => {
    const { app, github, token } = await start();
    const first = await refreshed(app, token);
    github.installationsDown = true;
    const down = await refreshed(app, token, first.installationsCheckedAt);
    expect(down.installations).toMatchObject(READ);
    expect(down.installationsCheckedAt).toBe(first.installationsCheckedAt);
    expect(down.installationsError).toMatch(/^GitHub could not say where the app is installed: .+/);
    github.installationsDown = false;
    const up = await refreshed(app, token, first.installationsCheckedAt);
    expect(up).not.toHaveProperty('installationsError');
    expect(up.installations).toMatchObject(READ);
  });

  it('keeps what was read across a restart, and the next Refresh still takes the 304 path', async () => {
    const { app, github, db, token } = await start();
    const read = await refreshed(app, token);
    await app.stop();
    const from = github.requests.length;
    const next = await startOn(db.dbPath, github, false);
    const after = await account(next.app);
    expect(after.installations).toMatchObject(READ);
    expect(after.installationsCheckedAt).toBe(read.installationsCheckedAt);
    expect(installs(github.requests.slice(from))).toEqual([]);
    await refreshed(next.app, next.token, read.installationsCheckedAt);
    const asked = installs(github.requests.slice(from));
    expect(asked).toHaveLength(3);
    expect(asked.filter((r) => !r.notModified)).toEqual([]);
  });
});
