// Issue #1243 part 3: the GitHub App source's setup card lets a person pick a GitHub App that is already installed on an
// organization, so its id and slug need not be looked up on GitHub. GET /api/github-apps lists, with the person's own GitHub
// connection, the apps installed on each organization the connection knows: those the hopper's app is installed on, as
// last read, and the owners of the job repositories. The daemon, store and HTTP edge are real; GitHub is a fake on loopback.
//
// Feature: pick an installed GitHub App
//   Scenario: the apps of each organization the connection knows
//     Given a connected account whose job repositories are in two organizations
//     When the person asks for the installed apps
//     Then each app installed on an organization it may list is answered, with its id and slug
//     And an organization GitHub refuses to list is named, with what it needs
//     And the account's own login is not asked as an organization
//   Scenario: no connection
//     Then the answer says to connect GitHub, and GitHub gets no request
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledAppsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start(connect: boolean): Promise<{ app: TestApp; github: FakeForge }> {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.orgApps = { 'octo-org': [{ id: 4242, slug: 'octo-intake' }, { id: 7, slug: 'ci-bot' }], 'other-org': 403 };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (connect) connectGitHub(app, ['octo-org/tools', 'other-org/site', 'owner/notes']);
  return { app, github };
}

const orgReads = (github: FakeForge): string[] => github.requests.filter((r) => r.path.startsWith('/api/v3/orgs/')).map((r) => r.path);

describe('pick an installed GitHub App (#1243)', () => {
  it('lists the apps installed on each organization the connection knows, and names one GitHub refuses', async () => {
    const { app, github } = await start(true);
    const r = await app.api<InstalledAppsView>('GET', '/api/github-apps');
    expect(r.status).toBe(200);
    expect(r.body.apps).toEqual([
      { account: 'octo-org', appId: 4242, slug: 'octo-intake', settingsUrl: `${github.url}/organizations/octo-org/settings/installations/100` },
      { account: 'octo-org', appId: 7, slug: 'ci-bot', settingsUrl: `${github.url}/organizations/octo-org/settings/installations/101` },
    ]);
    expect(r.body.refused).toEqual([{ account: 'other-org', error: expect.stringMatching(/GitHub answered 403.*owner.*Administration/) }]);
    expect(r.body).not.toHaveProperty('notConnected');
    expect(orgReads(github).sort()).toEqual(['/api/v3/orgs/octo-org/installations', '/api/v3/orgs/other-org/installations']);
  });

  it('with no connected account, says to connect GitHub and asks GitHub nothing', async () => {
    const { app, github } = await start(false);
    const r = await app.api<InstalledAppsView>('GET', '/api/github-apps');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ apps: [], refused: [], notConnected: expect.stringMatching(/GitHub is not connected/) });
    expect(orgReads(github)).toEqual([]);
  });
});
