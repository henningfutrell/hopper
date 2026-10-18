// Issue #429: the contribution flow. A job of a repository its user cannot push to works through a fork: the hopper
// forks the repository into the user's account, the job pushes its branch to that fork and opens its pull request on the
// repository it came from, from the fork; when that repository takes no issues, the job files its issue on the fork. All
// of it only while the user's Contribution setting is on. The daemon, store and HTTP edge are real; GitHub is a fake on
// loopback whose git is git's own `git-http-backend` over bare repositories (test/support/fake-forges.ts,
// test/support/fake-forks.ts); the job runs the real git with its variables and the real `hopper-gh` script.
//
// Feature: contributing to a repository the user cannot push to
//   Scenario: Contribution is off by default
//     Given a job of upstream/lib, a repository its user cannot push to
//     Then GET /api/contribution says off, the hopper forks nothing, and a push to upstream/lib is refused
//     And each refusal says a person turns Contribution on in Settings
//   Scenario: an admin turns it on, and the job contributes through a fork
//     When an admin turns Contribution on (recorded with who)
//     And the job asks the hopper whether it can push to upstream/lib, and to fork it
//     Then a push to upstream/lib is refused, naming the fork command
//     And the hopper forks upstream/lib into the user's account, and answers the fork and the steps
//     And the job clones the fork, pushes its branch there, and opens its pull request on upstream/lib from the fork
//     And it pushes nothing to the fork's default or a release branch
//   Scenario: the repository takes no issues
//     Then the fork's issues are turned on, and the job files its issue on the fork, linked back to upstream/lib#7
//   Scenario: a repository that is no fork of the job's own
//     Then a push to it is taken where its user can push (issue #1806), and an issue on it is refused
//   Scenario: a repository its user can push to
//     Then the hopper forks nothing: the job pushes a branch there
//   Scenario: Contribution turned off after the fork was made
//     Then a push to the fork is taken (its user can push there, issue #1806), and a pull request from it is refused
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const run = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> => new Promise((resolve) => {
  execFile(cmd, args, { ...o }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

/** A bare repository on the fake GitHub: `dev`, its default, with one commit. */
async function bareRepo(root: string, repo: string): Promise<void> {
  const bare = join(root, `${repo}.git`);
  const seed = mkdtempSync(join(tmpdir(), 'hopper-contrib-seed-'));
  const env = { PATH: process.env.PATH, HOME: seed, GIT_CONFIG_NOSYSTEM: '1' };
  mkdirSync(join(root, repo.split('/')[0]!), { recursive: true });
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=dev', bare], { env });
  await run('git', ['init', '--quiet', '--initial-branch=dev', seed], { env });
  writeFileSync(join(seed, 'CONTRIBUTING.md'), 'Branches are named fix/<topic>.\n');
  await run('git', ['-C', seed, 'add', '.'], { env });
  await run('git', ['-C', seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '-m', 'first'], { env });
  await run('git', ['-C', seed, 'push', '--quiet', bare, 'dev'], { env });
  rmSync(seed, { recursive: true, force: true });
}

async function start(o: { issuesOff?: boolean } = {}) {
  const gitRoot = mkdtempSync(join(tmpdir(), 'hopper-contrib-forge-'));
  cleanups.push(() => rmSync(gitRoot, { recursive: true, force: true }));
  for (const repo of ['upstream/lib', 'octo/tools', 'elsewhere/x']) await bareRepo(gitRoot, repo);
  const github = await createFakeGitHub({ clientId: 'gh-client-id', gitRoot });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.notPushable = ['upstream/lib', 'elsewhere/x'];
  if (o.issuesOff) github.issuesOff = ['upstream/lib'];
  github.issues.push({ repo: 'upstream/lib', number: 7, title: 'Fix the parser', body: 'It fails on empty input.', author: 'owner', labels: ['hopper'] });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-contrib-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['upstream/lib', 'octo/tools']);
  return { app, github, gitRoot, root, held: h.held };
}

type Started = Awaited<ReturnType<typeof start>>;

/** A job of `repo` running, with git and hopper-gh as it runs them on its machine. */
async function running(t: Started, repo = 'upstream/lib', number = 7) {
  const job = await t.app.pull({}, { executor: 'holder', repo, number }, ADMIN_ID);
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  const home = mkdtempSync(join(tmpdir(), 'hopper-contrib-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const gitEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_'))),
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    HOPPER_TOKEN_FILE: join(t.root, env.HOPPER_TOKEN_FILE!),
    GIT_AUTHOR_NAME: 'job', GIT_AUTHOR_EMAIL: 'job@example.invalid', GIT_COMMITTER_NAME: 'job', GIT_COMMITTER_EMAIL: 'job@example.invalid',
  };
  const git = (args: string[], cwd = home) => run('git', args, { cwd, env: gitEnv });
  const gh = async (args: string[]) => { const r = await hopperGh(t.root, env, args); return { ...r, answer: JSON.parse(r.stdout || '{}') as Record<string, unknown> }; };
  /** Clone `from`, commit a change on a new branch: the job's work, ready to push. */
  const work = async (from: string, dir: string) => {
    expect(await git(['clone', '--quiet', `${t.github.url}/${from}.git`, dir])).toMatchObject({ code: 0 });
    const at = join(home, dir);
    writeFileSync(join(at, 'fix.txt'), 'fixed\n');
    await git(['checkout', '--quiet', '-b', 'fix/empty-input'], at);
    await git(['add', '.'], at);
    expect((await git(['commit', '--quiet', '-m', 'Fix the parser on empty input'], at)).code).toBe(0);
    return at;
  };
  return { job, env, home, git, gh, work };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const branchesOf = (t: Started, repo: string) => run('git', ['--git-dir', join(t.gitRoot, `${repo}.git`), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { env: { PATH: process.env.PATH } }).then((r) => r.stdout.split('\n').filter(Boolean));
const turnOn = async (t: Started, on = true) => {
  const token = await t.app.login();
  return t.app.ui('/ui/api/contribution', { on }, { token });
};
const OFF = 'contributing through a fork is off: a person turns it on in Settings → Contribution';

describe('the contribution flow (issue #429)', () => {
  it('is off by default: nothing is forked, and a push to a repository the user cannot push to is refused, saying how to turn it on', async () => {
    const t = await start();
    expect((await t.app.api('GET', '/api/contribution')).body).toEqual({ on: false });
    const { gh, work, git } = await running(t);

    const view = await gh(['repo', 'view', '--repo', 'upstream/lib']);
    expect(view.answer).toMatchObject({ ok: true, op: 'repo.view', repo: 'upstream/lib', canPush: false, hasIssues: true, defaultBranch: 'dev', contribution: false });

    const fork = await gh(['repo', 'fork', '--repo', 'upstream/lib']);
    expect(fork.code).toBe(1);
    expect(fork.answer.error).toBe(`refused: ${OFF}`);
    expect(t.github.requests.filter((r) => r.path.endsWith('/forks'))).toEqual([]);

    const at = await work('upstream/lib', 'lib');
    const pushed = await git(['push', 'origin', 'HEAD:refs/heads/fix/empty-input'], at);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain(`your user cannot push to upstream/lib, and ${OFF}`);
    expect(await branchesOf(t, 'upstream/lib')).toEqual(['dev']);
  });

  it('turned on by an admin: the job forks the repository, pushes its branch to the fork and opens its pull request upstream from it', async () => {
    const t = await start();
    const changed = await turnOn(t);
    expect(changed).toMatchObject({ status: 200, body: { on: true } });
    const [event] = eventsOf(t.app, 'contribution.changed');
    expect(event!.data).toMatchObject({ from: { on: false }, to: { on: true } });
    expect(typeof event!.data.by).toBe('string');

    const { job, gh, work, git } = await running(t);
    const upstream = await work('upstream/lib', 'lib');
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/fix/empty-input'], upstream);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('your user cannot push to upstream/lib: contribute through a fork: sh "$HOPPER_GH" repo fork --repo upstream/lib');

    const fork = await gh(['repo', 'fork', '--repo', 'upstream/lib']);
    expect(fork).toMatchObject({ code: 0 });
    expect(fork.answer).toMatchObject({
      ok: true, op: 'repo.fork', repo: 'upstream/lib', fork: 'owner/lib', url: `${t.github.url}/owner/lib`, defaultBranch: 'dev', issues: 'upstream/lib',
      next: expect.stringContaining('CONTRIBUTING'),
    });
    expect(t.github.forks).toEqual({ 'owner/lib': 'upstream/lib' });
    expect(t.github.requests.find((r) => r.path.endsWith('/forks'))?.auth).toBe('token test-account-token');
    // Asked again, the same fork: GitHub answers the one the user has.
    expect((await gh(['repo', 'fork', '--repo', 'upstream/lib'])).answer).toMatchObject({ ok: true, fork: 'owner/lib' });

    const at = await work('owner/lib', 'fork');
    expect(await git(['push', 'origin', 'HEAD:refs/heads/fix/empty-input'], at)).toMatchObject({ code: 0 });
    expect(await branchesOf(t, 'owner/lib')).toEqual(['dev', 'fix/empty-input']);
    expect(await branchesOf(t, 'upstream/lib')).toEqual(['dev']);
    for (const r of t.github.gitRequests.filter((x) => x.path.startsWith('/owner/lib'))) expect(r.auth).not.toBe('');
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'owner/lib', refs: ['refs/heads/fix/empty-input'] }) }),
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'repo.fork', repo: 'upstream/lib', fork: 'owner/lib' }) }),
    ]));
    for (const branch of ['dev', 'main']) {
      const kept = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], at);
      expect(kept.code).not.toBe(0);
      expect(kept.stderr).toContain(`never to ${branch}`);
    }

    const pr = await gh(['pr', 'create', '--repo', 'upstream/lib', '--head', 'owner:fix/empty-input', '--title', 'Fix the parser on empty input', '--body', 'Closes #7']);
    expect(pr).toMatchObject({ code: 0 });
    expect(pr.answer).toMatchObject({ ok: true, op: 'pr.create', repo: 'upstream/lib', number: 8, url: `${t.github.url}/upstream/lib/pull/8` });
    expect(t.github.requests.find((r) => r.method === 'POST' && r.path.endsWith('/upstream/lib/pulls'))?.body).toMatchObject({ head: 'owner:fix/empty-input', base: 'dev' });

    const other = await gh(['pr', 'create', '--repo', 'upstream/lib', '--head', 'someone:fix/empty-input', '--title', 'x', '--body', 'y']);
    expect(other.code).toBe(1);
    expect(other.answer.error).toBe('refused: a job opens a pull request from a fork only from its user\'s own (owner), not someone');
    const onFork = await gh(['pr', 'create', '--repo', 'owner/lib', '--head', 'fix/empty-input', '--title', 'x', '--body', 'y']);
    expect(onFork.answer.error).toBe('refused: open the pull request on upstream/lib, from the fork: --repo upstream/lib --head owner:<branch>');
  });

  it('a repository that takes no issues: the fork\'s issues are turned on, and the job files its issue there, linked back', async () => {
    const t = await start({ issuesOff: true });
    await turnOn(t);
    const { job, gh } = await running(t);
    expect((await gh(['repo', 'view', '--repo', 'upstream/lib'])).answer).toMatchObject({ hasIssues: false, contribution: true });
    const fork = await gh(['repo', 'fork', '--repo', 'upstream/lib']);
    expect(fork.answer).toMatchObject({ ok: true, fork: 'owner/lib', issues: 'owner/lib' });
    expect(t.github.issuesOff).toEqual(['upstream/lib']);

    const issue = await gh(['issue', 'create', '--repo', 'owner/lib', '--title', 'The parser fails on empty input', '--body', 'Seen in upstream/lib.']);
    expect(issue).toMatchObject({ code: 0 });
    expect(issue.answer).toMatchObject({ ok: true, op: 'issue.create', repo: 'owner/lib', number: 1, parent: 'upstream/lib#7' });
    const filed = t.github.issues.find((i) => i.repo === 'owner/lib')!;
    expect(filed.body).toContain('Follow-up of upstream/lib#7.');
    expect(filed.body).toContain(`Filed through hopper for job \`${job.id}\``);
    expect((await gh(['issue', 'view', '1', '--repo', 'owner/lib'])).answer).toMatchObject({ ok: true, number: 1 });
  });

  it('a repository that is no fork of the job\'s own: a push where its user can push (issue #1806), no issue', async () => {
    const t = await start();
    await turnOn(t);
    t.github.forks = { 'owner/x': 'elsewhere/x' };
    await bareRepo(t.gitRoot, 'owner/x');
    const { gh, work, git } = await running(t);
    const at = await work('owner/x', 'x');
    expect(await git(['push', 'origin', 'HEAD:refs/heads/fix/empty-input'], at)).toMatchObject({ code: 0 });
    expect(await branchesOf(t, 'owner/x')).toEqual(['dev', 'fix/empty-input']);
    const issue = await gh(['issue', 'create', '--repo', 'owner/x', '--title', 'x', '--body', 'y']);
    expect(issue.answer.error).toBe('refused: owner/x is not one of the repositories the hopper works on, so it does nothing there for a job but open a pull request from a branch it pushed');
  });

  it('a repository the user can push to is not forked: the job pushes a branch there', async () => {
    const t = await start();
    await turnOn(t);
    const { gh } = await running(t, 'octo/tools', 3);
    expect((await gh(['repo', 'view', '--repo', 'octo/tools'])).answer).toMatchObject({ canPush: true });
    const fork = await gh(['repo', 'fork', '--repo', 'octo/tools']);
    expect(fork.code).toBe(1);
    expect(fork.answer.error).toBe('refused: your user can push to octo/tools: push a branch there, with no fork');
    const other = await gh(['repo', 'fork', '--repo', 'upstream/lib']);
    expect(other.answer.error).toBe('refused: a job forks only its own repository (octo/tools)');
  });

  it('turned off after the fork was made: a push to the fork is taken (its user can push there, issue #1806), a pull request from it is refused', async () => {
    const t = await start();
    await turnOn(t);
    const { gh, work, git } = await running(t);
    expect((await gh(['repo', 'fork', '--repo', 'upstream/lib'])).code).toBe(0);
    const at = await work('owner/lib', 'fork');
    await turnOn(t, false);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/fix/empty-input'], at)).toMatchObject({ code: 0 });
    const pr = await gh(['pr', 'create', '--repo', 'upstream/lib', '--head', 'owner:fix/empty-input', '--title', 'x', '--body', 'y']);
    expect(pr.answer.error).toBe(`refused: ${OFF}`);
  });

  it('the setting: refused without a UI session or with no `on`; a save that changes nothing records nothing', async () => {
    const t = await start();
    expect((await t.app.ui('/ui/api/contribution', { on: true })).status).toBe(403);
    const token = await t.app.login();
    expect((await t.app.ui('/ui/api/contribution', {}, { token })).status).toBe(400);
    expect((await t.app.ui('/ui/api/contribution', { on: false }, { token })).status).toBe(200);
    expect(eventsOf(t.app, 'contribution.changed')).toEqual([]);
  });
});
