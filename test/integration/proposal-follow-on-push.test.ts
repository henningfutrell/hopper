// Issue #859: a follow-on of a proposal's path pushes its branch and opens its pull request on its parent's repository,
// through the hopper, as any job of that repository does. Before, it had no source of its own and the hopper refused
// both: "this job has none". The daemon, store and HTTP edge are real; GitHub is a fake on loopback with real bare
// repositories (test/support/fake-forges.ts); the job's machine is a holder (test/support/job-holder.ts) running real
// git and the real `hopper-gh` script.
//
// Feature: a proposal's follow-on ships on its parent's repository
//   Scenario: the follow-on pushes a branch and opens its pull request
//     Given a job of octo/tools#7 whose proposal a person accepted, selecting path 1
//     When its follow-on clones octo/tools, pushes a branch and runs `hopper-gh pr create --repo octo/tools`
//     Then the branch is on GitHub and the pull request is open, both with the hopper's connection
//     And a pull request on another repository is still refused
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { Job, ReviewItemView } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { THREE_PATHS } from '../support/proposal-paths.ts';
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
  const seed = mkdtempSync(join(tmpdir(), 'hopper-git-seed-'));
  const env = { PATH: process.env.PATH, HOME: seed, GIT_CONFIG_NOSYSTEM: '1' };
  const id = ['-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid'];
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=dev', join(root, `${repo}.git`)], { env });
  await run('git', ['init', '--quiet', '--initial-branch=dev', seed], { env });
  await run('git', ['-C', seed, ...id, 'commit', '--quiet', '--allow-empty', '-m', 'first'], { env });
  await run('git', ['-C', seed, 'push', '--quiet', join(root, `${repo}.git`), 'dev'], { env });
  rmSync(seed, { recursive: true, force: true });
}

async function start() {
  const gitRoot = mkdtempSync(join(tmpdir(), 'hopper-git-forge-'));
  cleanups.push(() => rmSync(gitRoot, { recursive: true, force: true }));
  for (const repo of ['octo/tools', 'octo/site']) await bareRepo(gitRoot, repo);
  const github = await createFakeGitHub({ clientId: 'gh-client-id', gitRoot });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-follow-on-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  // The parent writes the proposal; its follow-on holds its lane, as a running agent does.
  const executor: Executor = {
    ...h.executor, reviews: true,
    run: async (ctx) => (ctx.job.followOn ? h.executor.run(ctx) : { kind: 'report', review: 'proposal', report: { text: THREE_PATHS, recentOutput: '' } }),
  };
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  return { app, github, gitRoot, root, held: h.held };
}

const jobs = async (app: TestApp): Promise<Job[]> => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;

describe('a proposal\'s follow-on ships on its parent\'s repository (issue #859)', () => {
  it('pushes a branch and opens its pull request on the parent\'s repository; another repository is refused', async () => {
    const t = await start();
    const token = await t.app.login();
    const parent = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7, url: `${t.github.url}/octo/tools/issues/7` });
    const p = await waitFor(async () => (await t.app.api<{ items: ReviewItemView[] }>('GET', '/api/proposals')).body.items
      .find((x) => x.jobId === parent.id && x.stage === 'human'), { what: 'the proposal for a person' });
    expect((await t.app.ui(`/ui/api/proposals/${p.id}/accept`, { paths: [{ id: '1' }] }, { token })).status).toBe(200);
    const followOn = await waitFor(async () => (await jobs(t.app)).find((j) => j.followOn?.jobId === parent.id), { what: 'the follow-on' });
    expect(followOn.source).toMatchObject({ repo: 'octo/tools', number: 7 });
    const env = await waitFor(async () => t.held.get(followOn.id)?.env, { what: 'the follow-on to run' });

    const home = mkdtempSync(join(tmpdir(), 'hopper-git-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const gitEnv: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_'))),
      PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HOPPER_TOKEN_FILE: join(t.root, env.HOPPER_TOKEN_FILE!),
      GIT_AUTHOR_NAME: 'job', GIT_AUTHOR_EMAIL: 'job@example.invalid', GIT_COMMITTER_NAME: 'job', GIT_COMMITTER_EMAIL: 'job@example.invalid',
    };
    const git = (args: string[], cwd = home) => run('git', args, { cwd, env: gitEnv });
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(home, 'tools');
    writeFileSync(join(work, 'shed.md'), 'two coats\n');
    expect((await git(['add', '.'], work)).code).toBe(0);
    expect((await git(['commit', '--quiet', '-m', 'Brush two coats'], work)).code).toBe(0);
    expect(await git(['push', 'origin', 'HEAD:refs/heads/issue-7-brush'], work)).toMatchObject({ code: 0 });
    const branches = await run('git', ['--git-dir', join(t.gitRoot, 'octo/tools.git'), 'branch', '--list', 'issue-7-brush'], { env: { PATH: process.env.PATH } });
    expect(branches.stdout).toContain('issue-7-brush');

    const pr = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-brush', '--title', 'Brush two coats', '--body', 'Closes #7']);
    expect(JSON.parse(pr.stdout)).toMatchObject({ ok: true, op: 'pr.create', head: 'issue-7-brush', base: 'dev' });

    const elsewhere = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/site', '--head', 'x', '--title', 'x', '--body', 'x']);
    expect(JSON.parse(elsewhere.stdout).error).toBe('refused: a job opens a pull request only on its own repository (octo/tools)');
  });
});
