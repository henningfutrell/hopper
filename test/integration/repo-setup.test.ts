// Issue #652 requirement 8: the hopper checks the setup of each job repository — its default branch and each release
// branch it has need a pull request and a status check and take no force push, and secret scanning and push protection
// are on — and says what is missing. The daemon, store, HTTP edge and CLI are real; GitHub is a fake on loopback
// (test/support/fake-forges.ts), read with the person's own GitHub connection.
//
// Feature: Repository setup
//   Scenario: a repository set up as the hopper asks
//     Given a job repository whose dev, beta and stable need a pull request and a status check and take no force push
//     And secret scanning and push protection are on, and the connection is a repository admin
//     When the person reads the repositories' checks
//     Then its setup is "set up", with no problem
//   Scenario: a repository not set up
//     Given a job repository where dev takes a direct push, beta has no protection, stable allows force pushes, and
//       secret scanning and push protection are off
//     Then its setup is "not set up", and it names each problem
//   Scenario: rulesets, read without admin
//     Given a job repository whose dev is guarded by a ruleset, read by a connection that is no repository admin
//     Then dev has no problem, and the security settings are unread: the setup is "unknown", never "set up"
//   Scenario: GitHub cannot be read
//     Then the setup is unknown
//   Scenario: the CLI answers the same, as JSON
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { RepoChecks, RepoChecksView } from '../../src/domain/types.ts';
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

const GOOD = 'octo/good';
const LOOSE = 'octo/loose';
const RULED = 'octo/ruled';
const DOWN = 'octo/down';
const REPOS = [GOOD, LOOSE, RULED, DOWN];
const guarded = { protection: { pullRequest: true, forcePushes: false, checks: ['pr / test'] } };

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.repoChecks = {
    [GOOD]: { required: ['pr / test'], setup: { admin: true, secretScanning: true, pushProtection: true, branches: { dev: guarded, beta: guarded, stable: guarded, 'issue-1': {} } } },
    [LOOSE]: {
      required: ['pr / test'],
      setup: {
        admin: true, secretScanning: false, pushProtection: false,
        branches: { dev: { protection: { checks: ['pr / test'] } }, beta: {}, stable: { protection: { pullRequest: true, forcePushes: true, checks: ['pr / test'] } } },
      },
    },
    [RULED]: { ruleset: ['pr / test'], setup: { branches: { dev: { rules: ['pull_request', 'non_fast_forward', 'required_status_checks'] } } } },
    [DOWN]: { down: true },
  };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, REPOS);
  return { app, github };
}

async function checked(app: TestApp): Promise<RepoChecksView> {
  let view: RepoChecksView = { repos: [] };
  await expect.poll(async () => {
    view = (await app.api<RepoChecksView>('GET', '/api/repo-checks')).body;
    return view.repos.length > 0 && view.repos.every((r) => r.checkedAt !== undefined);
  }, { timeout: 10_000 }).toBe(true);
  return view;
}
const of = (v: RepoChecksView, repo: string): RepoChecks => v.repos.find((r) => r.repo === repo)!;

describe('Repository setup', () => {
  it('a repository set up as the hopper asks: dev, beta and stable guarded, secret scanning and push protection on', async () => {
    const { app } = await start();
    const v = of(await checked(app), GOOD);
    expect(v.setup).toEqual({ state: 'set up', problems: [], unread: [] });
    expect(v.found?.setup).toEqual({
      branches: ['dev', 'beta', 'stable'].map((branch) => ({ branch, pullRequest: true, statusCheck: true, forcePushBlocked: true })),
      secretScanning: true, pushProtection: true,
    });
    expect(v.state).toBe('checks');
  });

  it('a repository not set up names each problem', async () => {
    const { app } = await start();
    expect(of(await checked(app), LOOSE).setup).toEqual({
      state: 'not set up',
      problems: [
        'dev takes a push with no pull request',
        'beta takes a push with no pull request',
        'beta requires no status check',
        'beta allows force pushes',
        'stable allows force pushes',
        'secret scanning is off',
        'push protection is off',
      ],
      unread: [],
    });
  });

  it('a ruleset guards a branch without admin; what only an admin sees is unread, so the setup is unknown', async () => {
    const { app } = await start();
    const v = of(await checked(app), RULED);
    expect(v.found?.setup?.branches).toEqual([{ branch: 'dev', pullRequest: true, statusCheck: true, forcePushBlocked: true }]);
    expect(v.setup).toEqual({ state: 'unknown', problems: [], unread: ['whether secret scanning is on', 'whether push protection is on'] });
  });

  it('a protected branch whose protection only an admin sees is unread, never unprotected', async () => {
    const { app, github } = await start();
    github.repoChecks![GOOD]!.setup!.admin = false;
    const one = await app.api<RepoChecks>('GET', `/api/repo-checks?repo=${GOOD}`);
    expect(one.body.setup.state).toBe('unknown');
    expect(one.body.setup.problems).toEqual([]);
    expect(one.body.setup.unread).toEqual([
      'whether dev needs a pull request', 'whether dev allows force pushes',
      'whether beta needs a pull request', 'whether beta allows force pushes',
      'whether stable needs a pull request', 'whether stable allows force pushes',
      'whether secret scanning is on', 'whether push protection is on',
    ]);
  });

  it('GitHub out of reach: the setup is unknown', async () => {
    const { app } = await start();
    expect(of(await checked(app), DOWN).setup).toEqual({ state: 'unknown', problems: [], unread: [] });
  });

  it('hopper repo checks <repo> prints the setup too', async () => {
    const { app } = await start();
    const out: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
    expect(await runCli(['repo', 'checks', LOOSE, '--json', '--url', app.url], io)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ repo: LOOSE, setup: { state: 'not set up', problems: expect.arrayContaining(['secret scanning is off']) } });
  });
});
