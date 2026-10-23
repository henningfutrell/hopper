// The harness of the git proxy's tests (issue #652): a hopper whose GitHub is a fake on loopback, whose git is git's own
// `git-http-backend` over bare repositories (test/support/fake-forges.ts), and a job that runs the real git with the
// variables it was given, and the credential files the hopper kept for it on its machine.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts, DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakePull } from './fake-forges.ts';
import { connectGitHub } from './github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from './app.ts';
import { waitFor } from './wait.ts';

const apps: TestApp[] = [];
export const cleanups: (() => unknown)[] = [];
/** Stops each hopper and removes each directory a test started: call it in the test file's `afterEach`. */
export async function stopGitProxies(): Promise<void> {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
}

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

interface Run { code: number; stdout: string; stderr: string }

export const run = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> => new Promise((resolve) => {
  execFile(cmd, args, { ...o }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

/** A bare repository on the fake GitHub: `dev`, its default, with one commit. */
export async function bareRepo(root: string, repo: string): Promise<void> {
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

export async function start() {
  const gitRoot = mkdtempSync(join(tmpdir(), 'hopper-git-forge-'));
  cleanups.push(() => rmSync(gitRoot, { recursive: true, force: true }));
  for (const repo of ['octo/tools', 'octo/site', 'elsewhere/lib']) await bareRepo(gitRoot, repo);
  const pulls: FakePull[] = [];
  const github = await createFakeGitHub({ clientId: 'gh-client-id', gitRoot, pulls });
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
      const env = { ...(await ctx.credentials?.(`/work/.worktrees/@scratch/${ctx.job.id}`)) };
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
  return { app, github, gitRoot, root, held, pulls };
}

export type Started = Awaited<ReturnType<typeof start>>;

/** A job of the user's own repository `repo`, running: its variables, and git as it runs on its machine. */
/** A job at work on the holder executor: `made`, else one pulled for `repo`. */
export async function running(t: Started, repo = 'octo/tools', made?: Job) {
  const job = made ?? await t.app.pull({}, { executor: 'holder', repo }, ADMIN_ID);
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

export const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
export const branchesOf = (t: Started, repo: string) => run('git', ['--git-dir', join(t.gitRoot, `${repo}.git`), 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], { env: { PATH: process.env.PATH } });
/** Straight to the fake GitHub's bare repository, as a person's merge would: `files` committed on `branch`. */
export async function seedCommit(t: Started, repo: string, branch: string, files: Record<string, string>): Promise<void> {
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

export const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
