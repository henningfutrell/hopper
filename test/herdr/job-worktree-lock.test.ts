// One start at a time per repository (issue #1075): concurrent jobs on one machine share its repository checkout, so a
// start takes the repository's start lock around its fetch and its worktree add. Real git and sh, as in
// job-worktree.test.ts: what these commands do to a repository is what they do in a job's pane.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutOf, JOB_WORKTREE_LOCK, jobWorktreeOf, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';

import { GIT_ENV, ID, git, repository, served, sh } from './job-worktree-support.ts';

const idOf = (n: number): string => `abcdef12-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** Runs the command as the pane's shell would, without waiting for it; what it printed, once it ends. */
function started(cwd: string, jobId: string, command: string): Promise<string> {
  mkdirSync(jobScratchOf(cwd, jobId), { recursive: true });
  return new Promise((resolve) => {
    const c = spawn('sh', ['-c', command], { cwd, env: GIT_ENV });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
  });
}

const holders: ChildProcess[] = [];
afterEach(() => { for (const h of holders.splice(0)) h.kill(); });

/** The start lock of the repository at `gitDir`, held by a process that runs. */
function heldLock(gitDir: string): string {
  const lock = join(gitDir, JOB_WORKTREE_LOCK);
  const holder = spawn('sleep', ['60']);
  holders.push(holder);
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), `${holder.pid}\n`);
  return lock;
}

/** A tended checkout, cloned by a first job, of a repository served as GitHub serves one. */
function warmMirror(): { root: string; plain: string; bare: string; url: string; mirror: string } {
  const { root, origin } = repository();
  mkdirSync(join(root, 'acme'));
  const bare = join(root, 'acme', 'app.git');
  git(root, 'clone', '--quiet', '--bare', origin, bare);
  const plain = join(root, 'jobs');
  mkdirSync(plain);
  const url = served(bare);
  sh(plain, makeJobWorktreeCommand(plain, ID, { repo: 'acme/app', url }));
  return { root, plain, bare, url, mirror: join(checkoutOf(plain, 'acme/app'), '.git') };
}

const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

describe('one start at a time per repository mirror (issue #1075)', () => {
  it('a start waits while another start holds the mirror\'s lock, then makes its worktree and lets the lock go', async () => {
    const { plain, url, mirror } = warmMirror();
    const lock = heldLock(mirror);
    const next = idOf(2);
    const done = started(plain, next, makeJobWorktreeCommand(plain, next, { repo: 'acme/app', url }));
    await wait(1500);
    expect(existsSync(jobWorktreeOf(plain, next, 'acme/app'))).toBe(false);
    spawnSync('rm', ['-rf', lock]);
    expect(await done).toBe('hopper-worktree-running\nhopper-job-worktree-checkout\n');
    expect(existsSync(join(jobWorktreeOf(plain, next, 'acme/app'), 'a.txt'))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  }, 20000);

  it('a lock whose start is gone (its process ended) is taken over, and said so', async () => {
    const { plain, url, mirror } = warmMirror();
    const lock = join(mirror, JOB_WORKTREE_LOCK);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${spawnSync('true').pid}\n`);
    const next = idOf(2);
    const out = await started(plain, next, makeJobWorktreeCommand(plain, next, { repo: 'acme/app', url }));
    expect(out).toContain('hopper-job-worktree-checkout');
    expect(out).toContain(`hopper: took over the start lock ${lock}`);
    expect(existsSync(lock)).toBe(false);
  }, 20000);

  it('concurrent starts share the mirror: each gets its worktree at what the remote has, and the mirror stays sound', async () => {
    const { root, plain, bare, url, mirror } = warmMirror();
    const ahead = join(root, 'ahead');
    git(root, 'clone', '--quiet', bare, ahead);
    writeFileSync(join(ahead, 'c.txt'), 'three\n');
    git(ahead, 'add', 'c.txt');
    git(ahead, 'commit', '--quiet', '-m', 'three');
    git(ahead, 'push', '--quiet', 'origin', 'HEAD:main');
    const ids = [2, 3, 4, 5, 6, 7].map(idOf);
    const outs = await Promise.all(ids.map((id) => started(plain, id, makeJobWorktreeCommand(plain, id, { repo: 'acme/app', url }))));
    const now = git(bare, 'rev-parse', 'main');
    for (const [i, id] of ids.entries()) {
      expect(outs[i]).toBe('hopper-worktree-running\nhopper-job-worktree-checkout\n');
      expect(git(jobWorktreeOf(plain, id, 'acme/app'), 'rev-parse', 'HEAD')).toBe(now);
      expect(git(jobWorktreeOf(plain, id, 'acme/app'), 'status', '--porcelain')).toBe('');
    }
    expect(git(join(mirror, '..'), 'worktree', 'list').split('\n')).toHaveLength(ids.length + 2);
    expect(spawnSync('git', ['fsck', '--no-progress'], { cwd: join(mirror, '..'), env: GIT_ENV }).status).toBe(0);
    expect(existsSync(join(mirror, JOB_WORKTREE_LOCK))).toBe(false);
  }, 60000);

  it('a work tree that is the job\'s repository takes its own repository\'s lock the same way', async () => {
    const { tree } = repository();
    mkdirSync(join(tree, '.worktrees', '@scratch'), { recursive: true });
    writeFileSync(join(tree, '.worktrees', '.gitignore'), '*\n');
    const lock = heldLock(join(tree, '.git'));
    const done = started(tree, ID, makeJobWorktreeCommand(tree, ID));
    await wait(1500);
    expect(existsSync(jobWorktreeOf(tree, ID))).toBe(false);
    spawnSync('rm', ['-rf', lock]);
    expect(await done).toBe('hopper-worktree-running\nhopper-job-worktree-made\n');
    expect(git(tree, 'status', '--porcelain')).toBe('');
  }, 20000);

  it('a worktree an earlier run of the job left is entered as it is, whatever holds the lock', async () => {
    const { plain, url, mirror } = warmMirror();
    heldLock(mirror);
    expect(await started(plain, ID, makeJobWorktreeCommand(plain, ID, { repo: 'acme/app', url }))).toBe('hopper-worktree-running\nhopper-job-worktree-checkout\n');
  }, 20000);
});
