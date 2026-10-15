// Issue #677: repositories with no checks. In a repository with no checks, yolo mode merges code nothing verified, so the
// hopper finds each job repository that has none and recommends a job that adds them. The daemon, store, HTTP edge and
// CLI are real; GitHub is a fake on loopback (test/support/fake-forges.ts), read with the person's own GitHub connection.
//
// Feature: Repositories with no checks
//   Scenario: a job repository with no checks is flagged, with the job that adds them
//     Given job repositories with required checks, with a ruleset, with a workflow on pull requests, with check runs
//       on a recent pull request, and one with none of these
//     When the person reads the repositories' checks
//     Then only the one with none says "no checks", and it recommends "Add PR checks to <repo>"
//     And each says its yolo mode
//   Scenario: one button queues the job as a normal issue assigned to the owner
//     When the person queues the recommended job
//     Then an issue "Add PR checks to <repo>" is filed with the hopper label, assigned to the connected account
//     And a second press answers the same issue and files no other
//     And repo_checks.job_queued is in the log
//   Scenario: the owner dismisses the recommendation for a repository
//     When the person dismisses it, it is gone, and it stays gone after a restart of the read; undismissed, it is back
//   Scenario: the recommendation goes away once checks run
//     Given a repository with no checks
//     When a workflow on pull requests is added and the repository is read again
//     Then it has checks and no recommendation
//   Scenario: GitHub cannot be read
//     Then the state is unknown with the reason, never "no checks"
//   Scenario: the CLI answers the same, as JSON
//     When the person runs hopper repo checks <repo>
//     Then it prints the repository's checks and the recommendation
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { ADMIN_ID, type DomainEvent, type RepoChecks, type RepoChecksView } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const BARE = 'octo/bare';
const REPOS = ['octo/guarded', 'octo/ruled', 'octo/ci', 'octo/ran', BARE];
const PR_WORKFLOW = 'name: ci\non:\n  pull_request:\n    branches: [dev]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm test }]\n';
const PUSH_WORKFLOW = 'name: release\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm run build }]\n';

async function start(o: { connected?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.repoChecks = {
    'octo/guarded': { required: ['test'] },
    'octo/ruled': { ruleset: ['build'] },
    'octo/ci': { workflows: { 'ci.yml': PR_WORKFLOW, 'release.yml': PUSH_WORKFLOW } },
    'octo/ran': { pullRequests: [null, 'SUCCESS'] },
    [BARE]: { workflows: { 'release.yml': PUSH_WORKFLOW }, pullRequests: [null, null] },
  };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (o.connected !== false) connectGitHub(app, REPOS);
  else app.user(ADMIN_ID).store.settings.setJobRepositories('github', REPOS);
  const token = await app.login();
  return { app, github, token };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

/** The list once Refresh read GitHub for every repository: it answers at once and reads GitHub after. */
async function checked(app: TestApp): Promise<RepoChecksView> {
  // A list never reads GitHub (issue #1250): Refresh reads each repository in the background.
  expect((await app.ui('/ui/api/repo-checks/refresh', {}, { token: await app.login() })).status).toBe(200);
  let view: RepoChecksView = { repos: [] };
  await expect.poll(async () => {
    view = (await app.api<RepoChecksView>('GET', '/api/repo-checks')).body;
    return view.repos.length > 0 && view.repos.every((r) => r.checkedAt !== undefined);
  }, { timeout: 10_000 }).toBe(true);
  return view;
}
const of = (v: RepoChecksView, repo: string): RepoChecks => v.repos.find((r) => r.repo === repo)!;

async function hopper(app: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', app.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('Repositories with no checks', () => {
  it('flags only the repository with no checks, and recommends the job that adds them', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [BARE]: true } }, { token })).status).toBe(200);
    const view = await checked(app);
    expect(view.repos.map((r) => r.repo)).toEqual(REPOS);
    expect(of(view, 'octo/guarded')).toMatchObject({ state: 'checks', found: { required: ['test'] } });
    expect(of(view, 'octo/ruled')).toMatchObject({ state: 'checks', found: { required: ['build'] } });
    expect(of(view, 'octo/ci')).toMatchObject({ state: 'checks', found: { workflows: ['ci.yml'] } });
    expect(of(view, 'octo/ran')).toMatchObject({ state: 'checks', found: { pullRequests: { read: 2, withChecks: 1 } } });
    for (const r of REPOS.filter((x) => x !== BARE)) expect(of(view, r).recommendation).toBeUndefined();
    expect(of(view, BARE)).toMatchObject({
      state: 'no checks', yolo: true, dismissed: false,
      found: { required: [], workflows: [], pullRequests: { read: 2, withChecks: 0 } },
      recommendation: { title: `Add PR checks to ${BARE}` },
    });
    expect(of(view, BARE).recommendation!.queued).toBeUndefined();
    expect(of(view, 'octo/ci').yolo).toBe(false);
  });

  it('queues the job as an issue with the hopper label, assigned to the connected account, once', async () => {
    const { app, github, token } = await start();
    await checked(app);
    const r = await app.ui<{ kind: string; number: number; url: string }>('/ui/api/repo-checks/queue', { repo: BARE }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: 'filed', number: 1, url: `${github.url}/${BARE}/issues/1` });
    const issue = github.issues.find((i) => i.repo === BARE)!;
    expect(issue).toMatchObject({ title: `Add PR checks to ${BARE}`, labels: ['hopper'], assignees: ['owner'], author: 'owner' });
    expect(issue.body).toMatch(/workflow that runs on pull requests/);
    expect(issue.body).toMatch(/typecheck, the lint, the tests and the build/);
    expect(issue.body).toMatch(/required status checks/);
    const create = github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${BARE}/issues`))!;
    expect(create.auth).toContain('test-account-token');

    const again = await app.ui<{ kind: string; number: number }>('/ui/api/repo-checks/queue', { repo: BARE }, { token });
    expect(again.body).toMatchObject({ kind: 'exists', number: 1 });
    expect(github.issues.filter((i) => i.repo === BARE)).toHaveLength(1);
    expect(of((await app.api<RepoChecksView>('GET', '/api/repo-checks')).body, BARE).recommendation).toEqual({
      title: `Add PR checks to ${BARE}`, queued: { number: 1, url: `${github.url}/${BARE}/issues/1` },
    });
    expect(eventsOf(app, 'repo_checks.job_queued').map((e) => e.data).reverse()).toEqual([
      { repo: BARE, number: 1, url: `${github.url}/${BARE}/issues/1`, existing: false, by: expect.any(String) },
      { repo: BARE, number: 1, url: `${github.url}/${BARE}/issues/1`, existing: true, by: expect.any(String) },
    ]);

    expect((await app.ui('/ui/api/repo-checks/queue', { repo: 'octo/ci' }, { token })).status).toBe(409);
    expect((await app.ui('/ui/api/repo-checks/queue', { repo: 'someone/else' }, { token })).status).toBe(404);
    expect((await app.ui('/ui/api/repo-checks/queue', { repo: 'not a repo' }, { token })).status).toBe(400);
  });

  it('finds a job queued before, on GitHub, and offers no second one', async () => {
    const { app, github } = await start();
    github.issues.push({ repo: BARE, number: 4, title: `Add PR checks to ${BARE}`, body: '', author: 'owner', labels: ['hopper'] });
    expect(of(await checked(app), BARE).recommendation).toEqual({ title: `Add PR checks to ${BARE}`, queued: { number: 4, url: `${github.url}/${BARE}/issues/4` } });
  });

  it('lets the owner dismiss the recommendation for a repository, and bring it back', async () => {
    const { app, token } = await start();
    await checked(app);
    const d = await app.ui<RepoChecks>('/ui/api/repo-checks/dismiss', { repo: BARE, dismissed: true }, { token });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ repo: BARE, state: 'no checks', dismissed: true });
    expect(d.body.recommendation).toBeUndefined();
    expect(app.user(ADMIN_ID).store.settings.getRepoChecksDismissed()).toEqual([BARE]);
    expect(of((await app.api<RepoChecksView>('GET', '/api/repo-checks')).body, BARE)).toMatchObject({ dismissed: true });
    const back = await app.ui<RepoChecks>('/ui/api/repo-checks/dismiss', { repo: BARE.toUpperCase(), dismissed: false }, { token });
    expect(back.body).toMatchObject({ dismissed: false, recommendation: { title: `Add PR checks to ${BARE}` } });
    expect(eventsOf(app, 'repo_checks.dismissed').map((e) => e.data).reverse()).toEqual([
      { repo: BARE, dismissed: true, by: expect.any(String) },
      { repo: BARE, dismissed: false, by: expect.any(String) },
    ]);
  });

  it('drops the recommendation once checks run', async () => {
    const { app, github } = await start();
    expect(of(await checked(app), BARE).state).toBe('no checks');
    github.repoChecks![BARE] = { workflows: { 'ci.yaml': 'on: [push, pull_request]\njobs: {}\n' } };
    const one = await app.api<RepoChecks>('GET', `/api/repo-checks?repo=${BARE}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ repo: BARE, state: 'checks', found: { workflows: ['ci.yaml'] } });
    expect(one.body.recommendation).toBeUndefined();
    expect(of((await app.api<RepoChecksView>('GET', '/api/repo-checks')).body, BARE).state).toBe('checks');
    expect((await app.api('GET', '/api/repo-checks?repo=someone/else')).status).toBe(404);
  });

  it('says unknown with the reason when GitHub cannot be read, never no checks', async () => {
    const { app, github, token } = await start();
    github.repoChecks![BARE] = { down: true };
    const v = of(await checked(app), BARE);
    expect(v.state).toBe('unknown');
    expect(v.error).toMatch(/503/);
    expect(v.recommendation).toBeUndefined();
    expect((await app.ui('/ui/api/repo-checks/queue', { repo: BARE }, { token })).status).toBe(409);
  });

  it('says unknown, and queues nothing, without a GitHub connection', async () => {
    const { app, github, token } = await start({ connected: false });
    const v = of(await checked(app), BARE);
    expect(v).toMatchObject({ state: 'unknown', error: expect.stringMatching(/not connected/) });
    const q = await app.ui<{ error: string }>('/ui/api/repo-checks/queue', { repo: BARE }, { token });
    expect(q.status).toBe(503);
    expect(github.issues).toHaveLength(0);
  });

  it('hopper repo checks <repo> prints the same as JSON', async () => {
    const { app } = await start();
    const r = await hopper(app, ['repo', 'checks', BARE, '--json']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ repo: BARE, state: 'no checks', recommendation: { title: `Add PR checks to ${BARE}` } });
    expect((await hopper(app, ['repo', 'checks'])).code).toBe(2);
    expect((await hopper(app, ['repo', 'checks', 'someone/else'])).code).toBe(2);
  });
});
