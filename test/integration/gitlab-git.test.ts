// Issue #1448 part 3 (design.md "Jobs through GitLab"): a job of a GitLab issue holds no GitLab token. Its git clone and push
// go to the hopper, which does them on GitLab with the token of its user's GitLab account; its push opens the merge request
// with git's push options; a push goes only to a branch of its own work. The daemon, store, HTTP edge and Access are real;
// GitLab is a fake on loopback whose git is git's own `git-http-backend` over bare repositories; the job runs the real git
// with the variables it was given, and the credential files the hopper kept for it on its machine.
//
// Feature: a GitLab job's git through the hopper
//   Scenario: a GitLab job clones its project and pushes a branch of its work with push options
//     Given a hopper whose user attached a GitLab account and picked ada/tools
//     And the account's own issue there, taken as a job, running on this machine with no GitLab login of its own
//     When the job clones the project from its GitLab URL and pushes a new branch with -o merge_request.create
//     Then the hopper pushes on GitLab with the account's token, the branch is on GitLab, and the push names the account
//   Scenario: the job pushes to the project's default branch
//     Then the push is refused with the reason, and nothing changes on GitLab
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts, DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitLab } from '../support/fake-gitlab.ts';
import { run } from '../support/git-proxy.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

/** A bare project on the fake GitLab: `main`, its default, with one commit; it takes push options, as GitLab does. */
async function bareProject(root: string, project: string): Promise<string> {
  const bare = join(root, `${project}.git`);
  const seed = temp('hopper-gitlab-seed-');
  const env = { PATH: process.env.PATH, HOME: seed, GIT_CONFIG_NOSYSTEM: '1' };
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare], { env });
  await run('git', ['--git-dir', bare, 'config', 'receive.advertisePushOptions', 'true'], { env });
  await run('git', ['init', '--quiet', '--initial-branch=main', join(seed, 'w')], { env });
  writeFileSync(join(seed, 'w', 'README.md'), `${project}\n`);
  await run('git', ['-C', join(seed, 'w'), 'add', '.'], { env });
  await run('git', ['-C', join(seed, 'w'), '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '--quiet', '-m', 'readme'], { env });
  await run('git', ['-C', join(seed, 'w'), 'push', '--quiet', bare, 'main'], { env });
  return bare;
}

async function start() {
  const gitRoot = temp('hopper-gitlab-forge-');
  const bare = await bareProject(gitRoot, 'ada/tools');
  const gitlab = await createFakeGitLab({ gitRoot, issues: [{ project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'It drops the last line.', author: 'ada', assignees: ['ada'], labels: ['hopper'] }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  const root = temp('hopper-gitlab-machine-');
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
      const aborted = await new Promise<boolean>((end) => {
        held.set(ctx.job.id, { env, end: () => end(false) });
        ctx.signal.addEventListener('abort', () => end(true), { once: true });
      });
      return aborted ? { kind: 'failed', error: 'aborted' } : { kind: 'finished', result: 'ended' };
    },
    resume: async () => ({ kind: 'failed', error: 'not resumed' }),
  };
  cleanups.push(() => { for (const j of held.values()) j.end(); });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], jobSources: [{ name: 'gitlab-account', plugin: 'gitlab-account', options: { executor: 'holder', pollSeconds: 30 } }] },
  });
  apps.push(app);
  const token = await app.login();
  await app.ui('/ui/api/gitlab-account', { action: 'connect', token: 'glpat-ada', baseUrl: gitlab.url }, { token });
  await app.ui('/ui/api/gitlab-account', { action: 'choose', projects: ['ada/tools'] }, { token });
  const key = `${gitlab.url}/ada/tools/-/issues/1`;
  const job = await waitFor(async () => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.find((j) => j.source?.key === key), { what: 'the GitLab issue\'s job' });
  const env = await waitFor(async () => held.get(job.id)?.env, { what: `job ${job.id} to run` });
  const home = temp('hopper-gitlab-home-');
  const gitEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_'))),
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    HOPPER_TOKEN_FILE: env.HOPPER_TOKEN_FILE === undefined ? '' : join(root, env.HOPPER_TOKEN_FILE),
    GIT_AUTHOR_NAME: 'job', GIT_AUTHOR_EMAIL: 'job@example.invalid', GIT_COMMITTER_NAME: 'job', GIT_COMMITTER_EMAIL: 'job@example.invalid',
  };
  const git = (args: string[], cwd = home) => run('git', args, { cwd, env: gitEnv });
  return { app, gitlab, bare, job, env, home, git };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const branches = (bare: string) => run('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], { env: { PATH: process.env.PATH } });

describe('a GitLab job\'s git through the hopper (issue #1448 part 3)', () => {
  it('clones its project and pushes a branch of its work with push options, with the account\'s token, on its timeline', async () => {
    const t = await start();
    expect(JSON.stringify(t.env)).not.toContain('glpat');
    expect(await t.git(['clone', '--quiet', `${t.gitlab.url}/ada/tools.git`, 'tools'])).toMatchObject({ code: 0 });
    const work = join(t.home, 'tools');
    writeFileSync(join(work, 'fix.txt'), 'fixed\n');
    expect((await t.git(['add', '.'], work)).code).toBe(0);
    expect((await t.git(['commit', '--quiet', '-m', 'Fix the parser'], work)).code).toBe(0);
    const pushed = await t.git(['push', '-o', 'merge_request.create', '-o', 'merge_request.target=main', '-o', 'merge_request.description=Closes #1', 'origin', 'HEAD:refs/heads/fix-parser'], work);
    expect(pushed).toMatchObject({ code: 0 });

    const head = (await t.git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branches(t.bare)).stdout).toContain(`fix-parser ${head}`);
    // The job asked the hopper, never GitLab: GitLab saw the account's token in every git request.
    expect(t.gitlab.gitRequests.length).toBeGreaterThan(0);
    for (const r of t.gitlab.gitRequests) expect(r).toMatchObject({ user: 'oauth2', token: 'glpat-ada' });
    expect(eventsOf(t.app, 'gitlab_proxy.done')).toEqual([
      expect.objectContaining({ jobId: t.job.id, data: expect.objectContaining({ op: 'git.push', project: 'ada/tools', refs: ['refs/heads/fix-parser'], as: 'ada' }) }),
    ]);
  });

  it('refuses a push to the project\'s default branch, with the reason, and GitLab is not changed', async () => {
    const t = await start();
    expect(await t.git(['clone', '--quiet', `${t.gitlab.url}/ada/tools.git`, 'tools'])).toMatchObject({ code: 0 });
    const work = join(t.home, 'tools');
    const before = (await branches(t.bare)).stdout;
    writeFileSync(join(work, 'fix.txt'), 'fixed\n');
    await t.git(['add', '.'], work);
    await t.git(['commit', '--quiet', '-m', 'Fix'], work);
    const pushed = await t.git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain('a job pushes only to a branch of its own work, never to main');
    expect((await branches(t.bare)).stdout).toBe(before);
    expect(eventsOf(t.app, 'gitlab_proxy.refused')).toEqual([expect.objectContaining({ jobId: t.job.id, data: expect.objectContaining({ project: 'ada/tools', refs: ['refs/heads/main'] }) })]);
  });
});
