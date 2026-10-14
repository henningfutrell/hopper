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
//   Scenario: a job reads a repository its jobs do not use (issue #1015)
//     Given a private repository outside the job repositories that the user's connection sees
//     Then the hopper reads it with the user's connection, and pushes nothing there
//   Scenario: the job's variables carry no GitHub token and no ssh agent
//   Scenario: a rebase onto dev that empties a file the pull request only edited (issue #1096, the shrink guard)
//     Then the push is refused with the file named, nothing changes on GitHub, and the refusal is on its timeline
//     And a resolution that keeps the lines of both sides goes through
//     And a job that ends with its last push refused ends failed, not done
//   Scenario: the pull request's own change empties the file
//     Then the rebase that keeps it empty goes through
//   Scenario: a rebase onto main, the pull request's base, while main shrank a file dev still has whole (issue #1147)
//     Given a repository whose default branch is dev, and a pull request into main
//     Then the guard compares the push with main: the rebase goes through, and a push that empties the file is refused
//   Scenario: a branch with no pull request, in a repository with landing batches (issue #1147)
//     Then the guard compares the push with the landing branch, main: a push that empties the file is refused, the rebase goes through
//   Scenario: an admin sets the guard's percent (Settings → Shrink guard)
//     Then a push that takes more than that percent of a file's lines is refused, and the change is recorded
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts, DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { githubTraffic } from '../../src/github-limiter/traffic.ts';
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
    async reach() { return undefined; },
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
      // An abort (cancel, park, shutdown) returns at once, as the port asks: the daemon's stop does not wait it out.
      const aborted = await new Promise<boolean>((end) => {
        held.set(ctx.job.id, { env, end: () => end(false) });
        ctx.signal.addEventListener('abort', () => end(true), { once: true });
      });
      return aborted ? { kind: 'failed', error: 'aborted' } : { kind: 'finished', result: 'ended' };
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

  // Issue #858: each fetch through the hopper is counted for its repository and its job, and the next sync pass tells it.
  it('counts each fetch of a job, never its push, in the next sync pass line', async () => {
    const t = await start();
    const { job, home, git } = await running(t);
    const logged = vi.spyOn(console, 'warn');
    cleanups.push(() => logged.mockRestore());
    await githubTraffic.pass('before', async () => undefined);
    expect((await git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(home, 'tools');
    expect((await git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Fix'], work);
    expect((await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7-fix'], work)).code).toBe(0);
    await githubTraffic.pass('probe', async () => undefined);
    const lines = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('hopper: GitHub traffic of sync pass'));
    const fetches = lines.join('\n').match(new RegExp(`octo/tools (\\d+); by ${job.id.slice(0, 8)} (\\d+)`, 'g')) ?? [];
    const sum = fetches.map((f) => Number(/octo\/tools (\d+)/.exec(f)![1])).reduce((a, b) => a + b, 0);
    expect(sum).toBe(2);
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

  it('reads a private repository its jobs do not use with its user\'s connection, and pushes nothing there (issue #1015)', async () => {
    const t = await start();
    writeFileSync(join(t.gitRoot, 'elsewhere/lib.git', 'hopper-private'), '');
    const { home, git } = await running(t);
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const reads = t.github.gitRequests.filter((r) => r.path.startsWith('/elsewhere/lib'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.auth).not.toBe('');
    const work = join(home, 'lib');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Not mine'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/issue-7-elsewhere'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a job pushes only to its own repository (octo/tools)');
    expect(t.github.gitRequests.filter((x) => x.path.startsWith('/elsewhere/lib') && x.path.endsWith('/git-receive-pack'))).toEqual([]);
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

/** Straight to the fake GitHub's bare repository, as a person's merge would: `files` committed on `branch`. */
async function seedCommit(t: Started, repo: string, branch: string, files: Record<string, string>): Promise<void> {
  const seed = mkdtempSync(join(tmpdir(), 'hopper-git-seed-'));
  cleanups.push(() => rmSync(seed, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: seed, GIT_CONFIG_NOSYSTEM: '1' };
  const bare = join(t.gitRoot, `${repo}.git`);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) await run('git', ['--git-dir', bare, 'config', k!, v!], { env });
  await run('git', ['clone', '--quiet', '--branch', branch, bare, join(seed, 'w')], { env });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, 'w', f)), { recursive: true });
    writeFileSync(join(seed, 'w', f), text);
  }
  await run('git', ['-C', join(seed, 'w'), 'add', '.'], { env });
  await run('git', ['-C', join(seed, 'w'), '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '-m', 'seed'], { env });
  await run('git', ['-C', join(seed, 'w'), 'push', '--quiet', 'origin', branch], { env });
}

const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

describe('the shrink guard (issue #1096)', () => {
  /** dev with a 200-line design; the job's branch issue-7 edits it (or `own` instead); then dev moves on to 220 lines. */
  async function branchThenDevMoves(t: Started, own: string = linesOf(201)) {
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(200) });
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'docs/design.md'), own);
    await r.git(['commit', '--quiet', '-am', 'Edit the design'], work);
    expect((await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).code).toBe(0);
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(220) });
    expect((await r.git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    return { ...r, work };
  }

  /** The job's resolution on dev's tip, `design` as docs/design.md, pushed over issue-7 with a lease. */
  async function resolve(r: Awaited<ReturnType<typeof branchThenDevMoves>>, design: string) {
    await r.git(['checkout', '--quiet', '-B', 'tended', 'origin/dev'], r.work);
    writeFileSync(join(r.work, 'docs/design.md'), design);
    await r.git(['commit', '--quiet', '--allow-empty', '-am', 'Resolve'], r.work);
    return r.git(['push', '--force-with-lease=issue-7:origin/issue-7', 'origin', 'HEAD:refs/heads/issue-7'], r.work);
  }

  it('refuses a rebase that empties a file the pull request only edited, then takes one that keeps both sides', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t);
    const before = (await branchesOf(t, 'octo/tools')).stdout;

    const blanked = await resolve(r, '');
    expect(blanked.code).not.toBe(0);
    expect(blanked.stderr).toContain('the shrink guard refused this push');
    expect(blanked.stderr).toContain('docs/design.md (220 lines on dev, 0 after)');
    expect((await branchesOf(t, 'octo/tools')).stdout).toBe(before);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: r.job.id, data: expect.objectContaining({ op: 'git.push', refs: ['refs/heads/issue-7'], shrunk: [{ path: 'docs/design.md', from: 220, to: 0, against: 'base' }] }) }),
    ]));

    expect(await resolve(r, linesOf(221))).toMatchObject({ code: 0 });
    t.held.get(r.job.id)!.end();
    await t.app.waitForStatus(r.job.id, 'finished');
  });

  it('a job that ends with its last push refused by the guard ends failed, saying so', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t);
    expect((await resolve(r, '')).code).not.toBe(0);
    t.held.get(r.job.id)!.end();
    const ended = await t.app.waitForStatus(r.job.id, 'failed');
    expect(JSON.stringify(ended)).toContain('the shrink guard refused its last push, which emptied or shrank docs/design.md');
  });

  it('the percent is an admin\'s setting: 50 by default, recorded when it changes, read at the next push', async () => {
    const t = await start();
    expect((await t.app.api('GET', '/api/shrink-guard')).body).toEqual({ percent: 50 });
    expect((await t.app.ui('/ui/api/shrink-guard', { percent: 20 })).status).toBe(403);
    const token = await t.app.login();
    for (const percent of [0, 101, 2.5]) expect((await t.app.ui('/ui/api/shrink-guard', { percent }, { token })).status).toBe(400);
    expect((await t.app.ui('/ui/api/shrink-guard', { percent: 50 }, { token })).status).toBe(200);
    expect(eventsOf(t.app, 'shrink_guard.changed')).toEqual([]);

    const r = await branchThenDevMoves(t);
    expect(await t.app.ui('/ui/api/shrink-guard', { percent: 20 }, { token })).toMatchObject({ status: 200, body: { percent: 20 } });
    expect(eventsOf(t.app, 'shrink_guard.changed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ from: { percent: 50 }, to: { percent: 20 } }) })]);
    // 220 lines on dev to 150: 32% lost, over 20%.
    const refused = await resolve(r, linesOf(150));
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('docs/design.md (220 lines on dev, 150 after)');
    // Under the default, it goes through.
    await t.app.ui('/ui/api/shrink-guard', { percent: 50 }, { token });
    expect(await resolve(r, linesOf(150))).toMatchObject({ code: 0 });
  });

  it('takes a rebase that keeps the file the pull request itself emptied', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t, '');
    expect(await resolve(r, '')).toMatchObject({ code: 0 });
  });

  /**
   * main from dev, with a 200-line design; the job's branch issue-7 off main edits notes.md; then dev moves on, main takes
   * dev and shrinks the design to 100 lines on purpose, which dev does not have.
   */
  async function branchThenMainShrinks(t: Started) {
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(200) });
    const bare = join(t.gitRoot, 'octo/tools.git');
    await run('git', ['--git-dir', bare, 'branch', 'main', 'dev']);
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', '--branch', 'main', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'notes.md'), 'notes\n');
    await r.git(['add', 'notes.md'], work);
    await r.git(['commit', '--quiet', '-m', 'Add notes'], work);
    expect((await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).code).toBe(0);
    await seedCommit(t, 'octo/tools', 'dev', { 'other.md': 'other\n' });
    await run('git', ['--git-dir', bare, 'update-ref', 'refs/heads/main', 'refs/heads/dev']);
    await seedCommit(t, 'octo/tools', 'main', { 'docs/design.md': linesOf(100) });
    expect((await r.git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    /** issue-7 rebased onto main's tip, `design` as docs/design.md, pushed with a lease. */
    const rebase = async (design = linesOf(100)) => {
      await r.git(['checkout', '--quiet', '-B', 'tended', 'origin/main'], work);
      writeFileSync(join(work, 'notes.md'), 'notes\n');
      writeFileSync(join(work, 'docs/design.md'), design);
      await r.git(['add', '.'], work);
      await r.git(['commit', '--quiet', '-m', 'Add notes'], work);
      return r.git(['push', '--force-with-lease=issue-7:origin/issue-7', 'origin', 'HEAD:refs/heads/issue-7'], work);
    };
    return { ...r, work, rebase };
  }

  it('compares a rebase with the pull request\'s base, not the default branch (issue #1147)', async () => {
    const t = await start();
    const r = await branchThenMainShrinks(t);
    const opened = await fetch(`${t.github.url}/api/v3/repos/octo/tools/pulls`, {
      method: 'POST', headers: { authorization: 'token test-account-token', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Add notes', body: 'Closes #7', head: 'issue-7', base: 'main' }),
    });
    expect(opened.status).toBe(201);

    const emptied = await r.rebase('');
    expect(emptied.code).not.toBe(0);
    expect(emptied.stderr).toContain('docs/design.md (100 lines on main, 0 after)');
    expect(await r.rebase()).toMatchObject({ code: 0 });
  });

  it('compares a branch with no pull request with the landing branch (issue #1147)', async () => {
    const t = await start();
    const token = await t.app.login();
    expect((await t.app.ui('/ui/api/landing-batches', { repos: { 'octo/tools': { tested: 'dev' } } }, { token })).status).toBe(200);
    const r = await branchThenMainShrinks(t);
    expect((await r.rebase('')).stderr).toContain('docs/design.md (100 lines on main, 0 after)');
    expect(await r.rebase()).toMatchObject({ code: 0 });
  });
});
