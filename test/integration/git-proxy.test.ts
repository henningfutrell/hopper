// Issue #652: a job holds no GitHub token. Its git fetch and push go to the hopper, which does them on GitHub with the
// connection of the job's own user; a push changes only a branch of the job's own repository, never its default or a
// release branch. The daemon, store and HTTP edge are real; GitHub is a fake on loopback whose git is git's own
// `git-http-backend` over bare repositories (test/support/fake-forges.ts); the job runs the real git with the variables
// it was given, and the credential files the hopper kept for it on its machine.
//
// Feature: git through the hopper
//   Scenario: a job clones its repository, and pushes a branch of its work
//     Given a hopper whose GitHub is connected, working on octo/tools
//     And a job of octo/tools running on this machine, with no GitHub login of its own
//     When the job clones https://github.com/octo/tools and pushes a new branch
//     Then the hopper fetches and pushes on GitHub with its user's connection, and the branch is on GitHub
//     And the push is on the job's timeline
//   Scenario: a job pushes to the default branch, or a release branch
//     Then the push is refused with the reason, nothing changes on GitHub, and the refusal is on its timeline
//   Scenario: a job pushes to another repository than its own
//     Then the push is refused with the reason
//   Scenario: a job reads a repository the hopper does not work on
//     Then the hopper reads it without credentials, as anyone could
//   Scenario: the job's variables carry no GitHub token and no ssh agent
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts, DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

interface Run { code: number; stdout: string; stderr: string }

const run = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> => new Promise((resolve) => {
  execFile(cmd, args, { ...o }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

/** A bare repository on the fake GitHub: `dev`, its default, with one commit. */
async function bareRepo(root: string, repo: string): Promise<void> {
  const bare = join(root, `${repo}.git`);
  const seed = mkdtempSync(join(tmpdir(), 'hopper-git-seed-'));
  const env = { PATH: process.env.PATH, HOME: seed, GIT_CONFIG_NOSYSTEM: '1' };
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=dev', bare], { env });
  await run('git', ['init', '--quiet', '--initial-branch=dev', seed], { env });
  writeFileSync(join(seed, 'README.md'), `${repo}\n`);
  await run('git', ['-C', seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'first'], { env });
  await run('git', ['-C', seed, 'add', '.'], { env });
  await run('git', ['-C', seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '-m', 'readme'], { env });
  await run('git', ['-C', seed, 'push', '--quiet', bare, 'dev'], { env });
  rmSync(seed, { recursive: true, force: true });
}

async function start() {
  const gitRoot = mkdtempSync(join(tmpdir(), 'hopper-git-forge-'));
  cleanups.push(() => rmSync(gitRoot, { recursive: true, force: true }));
  for (const repo of ['octo/tools', 'octo/site', 'elsewhere/lib']) await bareRepo(gitRoot, repo);
  const github = await createFakeGitHub({ clientId: 'gh-client-id', gitRoot });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-git-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const held = new Map<string, { env: Record<string, string>; end(): void }>();
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential(_jobId, dir, file, content) {
      const path = join(root, dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    async discover() { return NOTHING; },
  };
  const executor: Executor = {
    name: 'holder', idempotent: false, validate: () => null, machineShell: () => shell,
    async run(ctx) {
      const env = { ...(await ctx.credentials?.(`/work/.hopper-scratch/${ctx.job.id}`)) };
      await new Promise<void>((end) => held.set(ctx.job.id, { env, end }));
      return { kind: 'finished', result: 'ended' };
    },
    resume: async () => ({ kind: 'failed', error: 'not resumed' }),
  };
  cleanups.push(() => { for (const j of held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  return { app, github, gitRoot, root, held };
}

type Started = Awaited<ReturnType<typeof start>>;

/** A job of the user's own repository `repo`, running: its variables, and git as it runs on its machine. */
async function running(t: Started, repo = 'octo/tools') {
  const job = await t.app.pull({}, { executor: 'holder', repo }, ADMIN_ID);
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  const home = mkdtempSync(join(tmpdir(), 'hopper-git-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const onDisk = (v: string | undefined) => (v === undefined ? '' : join(t.root, v));
  const gitEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_'))),
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    HOPPER_TOKEN_FILE: onDisk(env.HOPPER_TOKEN_FILE),
    GIT_AUTHOR_NAME: 'job', GIT_AUTHOR_EMAIL: 'job@example.invalid', GIT_COMMITTER_NAME: 'job', GIT_COMMITTER_EMAIL: 'job@example.invalid',
  };
  const git = (args: string[], cwd = home) => run('git', args, { cwd, env: gitEnv });
  return { job, env, home, git };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const branchesOf = (t: Started, repo: string) => run('git', ['--git-dir', join(t.gitRoot, `${repo}.git`), 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], { env: { PATH: process.env.PATH } });
const basicOf = (auth: string): string => Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');

describe('git through the hopper (issue #652)', () => {
  it('a job clones its repository and pushes a branch of its work, with its user\'s connection, on its timeline', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    const remote = `${t.github.url}/octo/tools.git`;

    expect(await git(['clone', '--quiet', remote, 'tools'])).toMatchObject({ code: 0 });
    const work = join(home, 'tools');
    writeFileSync(join(work, 'fix.txt'), 'fixed\n');
    expect((await git(['add', '.'], work)).code).toBe(0);
    expect((await git(['commit', '--quiet', '-m', 'Fix'], work)).code).toBe(0);
    const pushed = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-fix'], work);
    expect(pushed).toMatchObject({ code: 0 });

    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'octo/tools')).stdout).toContain(`issue-7-fix ${head}`);
    // The job asked the hopper, never GitHub: GitHub saw the hopper's user's token, in every git request.
    const toGitHub = t.github.gitRequests.filter((r) => r.path.startsWith('/octo/tools'));
    expect(toGitHub.length).toBeGreaterThan(0);
    for (const r of toGitHub) expect(basicOf(r.auth)).toBe('x-access-token:test-account-token');
    expect(eventsOf(t.app, 'github_proxy.done')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/tools', refs: ['refs/heads/issue-7-fix'], own: true }) }),
    ]));

    // Updated and forced on its own branch: a rebase pushes with --force-with-lease.
    expect((await git(['commit', '--quiet', '--amend', '-m', 'Fix, again'], work)).code).toBe(0);
    expect(await git(['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).toMatchObject({ code: 0 });
  });

  it('refuses a push to the default branch or a release branch, saying why; nothing changes on GitHub', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    await git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools']);
    const work = join(home, 'tools');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Straight to dev'], work);
    const before = (await branchesOf(t, 'octo/tools')).stdout;

    for (const branch of ['dev', 'stable']) {
      const r = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], work);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`a job pushes only to a branch of its own work, never to ${branch}`);
    }
    const deleted = await git(['push', 'origin', ':refs/heads/dev'], work);
    expect(deleted.code).not.toBe(0);
    expect((await branchesOf(t, 'octo/tools')).stdout).toBe(before);
    expect(t.github.gitRequests.filter((r) => r.path.endsWith('/git-receive-pack'))).toEqual([]);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'git.push', repo: 'octo/tools', reason: expect.stringContaining('never to dev') }) }),
    ]));
  });

  it('refuses a push to another repository than the job\'s own', async () => {
    const t = await start();
    const { home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/site.git`, 'site'])).code).toBe(0);
    const work = join(home, 'site');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not mine'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-elsewhere'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a job pushes only to its own repository (octo/tools)');
    expect((await branchesOf(t, 'octo/site')).stdout).not.toContain('issue-7-elsewhere');
  });

  it('reads a repository the hopper does not work on without credentials, as anyone could', async () => {
    const t = await start();
    const { git } = await running(t);
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const reads = t.github.gitRequests.filter((r) => r.path.startsWith('/elsewhere/lib'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.auth).toBe('');
  });

  it('refuses a token that is no job\'s, and a job no longer at work', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const token = readFileSync(join(t.root, env.HOPPER_TOKEN_FILE!), 'utf8');
    const refs = (password: string) => fetch(`${t.app.url}/job/git/octo/tools.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`hopper-job:${password}`).toString('base64')}` },
    });
    expect((await refs(`${token.slice(0, -2)}xx`)).status).toBe(401);
    expect((await fetch(`${t.app.url}/job/git/octo/tools.git/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await refs(token)).status).toBe(200);
    t.held.get(job.id)!.end();
    await t.app.waitForStatus(job.id, 'finished');
    expect((await refs(token)).status).toBe(401);
  });

  it('gives the job git\'s way to the hopper and its token file, never a GitHub token or an ssh agent', async () => {
    const t = await start();
    const { env } = await running(t);
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GH_CONFIG_DIR');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(JSON.stringify(env)).not.toContain('test-account-token');
    expect(env).toMatchObject({ GIT_CONFIG_KEY_0: `url.${t.app.url}/job/git/.insteadOf`, GIT_CONFIG_VALUE_0: `${t.github.url}/` });
  });
});

