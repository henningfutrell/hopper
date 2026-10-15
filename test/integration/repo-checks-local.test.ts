// Issue #1250: Sources shows the job repositories' checks and setup from the hopper's database, and a page load never
// reads GitHub. GitHub is read in the background, on Refresh or on the schedule, with conditional requests: an answer
// GitHub says is unchanged (304) costs nothing. What was read, and each answer's ETag, survive a restart. The daemon,
// store and HTTP edge are real; GitHub is a fake on loopback that counts each request (test/support/fake-forges.ts).
//
// Feature: Sources from the hopper's database
//   Scenario: loading the list reads no GitHub
//     Given job repositories never read
//     When the person loads the list again and again
//     Then GitHub gets no request, and each repository is not read yet
//   Scenario: Refresh reads each repository once, in the background
//     When the person presses Refresh
//     Then the answer comes at once, and each repository is read once
//     And loads of the list after it read no GitHub
//   Scenario: an unchanged repository takes the 304 path
//     Given a repository read once
//     When the person presses Refresh again and nothing changed on GitHub
//     Then each of its requests is answered 304, and no GraphQL call is made for it
//   Scenario: what was read survives a restart
//     When the daemon starts again on the same database
//     Then the list shows what was read, when, with no GitHub request
//     And a Refresh after it still takes the 304 path
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type RepoChecks, type RepoChecksView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge, type ForgeRequest } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const STEADY = 'octo/steady';
const BARE = 'octo/bare';
const REPOS = [STEADY, BARE];
const PR_WORKFLOW = 'name: ci\non:\n  pull_request:\n    branches: [dev]\njobs: {}\n';
const guarded = { protection: { pullRequest: true, forcePushes: false, checks: ['pr / test'] } };

async function startOn(dbPath: string, github: FakeForge, connect: boolean) {
  const app = await startTestApp({
    dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (connect) connectGitHub(app, REPOS);
  return { app, token: await app.login() };
}

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.repoChecks = {
    // Every answer about it has an ETag: a workflow on pull requests, three guarded branches, read by an admin.
    [STEADY]: { workflows: { 'ci.yml': PR_WORKFLOW }, setup: { admin: true, secretScanning: true, pushProtection: true, branches: { dev: guarded, beta: guarded, stable: guarded } } },
    [BARE]: { pullRequests: [null] },
  };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return { github, db, ...(await startOn(db.dbPath, github, true)) };
}

/** The requests GitHub got about `repo`'s checks: REST under it, or the pull requests' check rollups that name it. */
const about = (requests: ForgeRequest[], repo: string): ForgeRequest[] => requests.filter((r) => r.path.startsWith(`/api/v3/repos/${repo}`)
  || (r.path === '/api/v3/graphql' && String(r.body.query).includes('pullRequests(last') && JSON.stringify(r.body.variables ?? {}).includes(`"${repo.split('/')[1]}"`)));
const of = (v: RepoChecksView, repo: string): RepoChecks => v.repos.find((r) => r.repo === repo)!;
const list = async (app: TestApp) => (await app.api<RepoChecksView>('GET', '/api/repo-checks')).body;

/** Refresh, then the list once every repository was read after `since`. */
async function refreshed(app: TestApp, token: string, since = ''): Promise<RepoChecksView> {
  const r = await app.ui<RepoChecksView>('/ui/api/repo-checks/refresh', {}, { token });
  expect(r.status).toBe(200);
  let view: RepoChecksView = { repos: [] };
  await expect.poll(async () => {
    view = await list(app);
    return view.repos.length > 0 && view.repos.every((x) => x.checkedAt !== undefined && x.checkedAt > since && !x.reading);
  }, { timeout: 10_000 }).toBe(true);
  return view;
}

describe('Sources from the hopper\'s database', () => {
  it('loads of the list read no GitHub; each repository is not read yet', async () => {
    const { app, github } = await start();
    for (let i = 0; i < 5; i++) {
      const v = await list(app);
      expect(v.repos.map((r) => r.repo)).toEqual(REPOS);
      for (const r of v.repos) {
        expect(r.state).toBe('unknown');
        expect(r.checkedAt).toBeUndefined();
      }
    }
    expect(REPOS.flatMap((r) => about(github.requests, r))).toEqual([]);
  });

  it('Refresh answers at once and reads each repository once; loads after it read no GitHub', async () => {
    const { app, github, token } = await start();
    const v = await refreshed(app, token);
    expect(of(v, STEADY)).toMatchObject({ state: 'checks', found: { workflows: ['ci.yml'] }, setup: { state: 'set up' } });
    expect(of(v, BARE)).toMatchObject({ state: 'no checks', found: { pullRequests: { read: 1, withChecks: 0 } } });
    expect(about(github.requests, STEADY).filter((r) => r.path === `/api/v3/repos/${STEADY}`)).toHaveLength(1);
    const seen = github.requests.length;
    for (let i = 0; i < 5; i++) await list(app);
    expect(REPOS.flatMap((r) => about(github.requests.slice(seen), r))).toEqual([]);
  });

  it('a Refresh of an unchanged repository is answered 304 throughout, with no GraphQL call', async () => {
    const { app, github, token } = await start();
    const first = await refreshed(app, token);
    const from = github.requests.length;
    await refreshed(app, token, of(first, STEADY).checkedAt);
    const again = about(github.requests.slice(from), STEADY);
    expect(again.length).toBeGreaterThan(0);
    expect(again.filter((r) => !r.notModified).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(again.some((r) => r.path === '/api/v3/graphql')).toBe(false);
    // Its answers and their ETags are in the database, beside what was read; so are the release branches it does not
    // have, answered 404 once and not asked again while the repository is unchanged.
    const kept = Object.entries(app.user(ADMIN_ID).store.repoChecks.get(STEADY)!.etags);
    expect(kept.filter(([, a]) => a.refused === undefined)).toHaveLength(again.length);
    expect(kept.filter(([, a]) => a.refused === 404).map(([k]) => /"branch":"([^"]+)"/.exec(k)?.[1]).sort()).toEqual(['canary', 'main', 'master']);
  });

  it('keeps what was read across a restart, and the next Refresh still takes the 304 path', async () => {
    const { app, github, db, token } = await start();
    const read = await refreshed(app, token);
    await app.stop();
    const from = github.requests.length;
    const next = await startOn(db.dbPath, github, false);
    const after = await list(next.app);
    expect(of(after, STEADY)).toMatchObject({ state: 'checks', checkedAt: of(read, STEADY).checkedAt, setup: { state: 'set up' } });
    expect(of(after, BARE)).toMatchObject({ state: 'no checks', checkedAt: of(read, BARE).checkedAt });
    expect(REPOS.flatMap((r) => about(github.requests.slice(from), r))).toEqual([]);
    await refreshed(next.app, next.token, of(read, STEADY).checkedAt);
    expect(about(github.requests.slice(from), STEADY).filter((r) => !r.notModified)).toEqual([]);
  });
});
