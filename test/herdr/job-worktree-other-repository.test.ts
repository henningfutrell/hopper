// Issue #431, run for real as test/herdr/job-worktree.test.ts runs the rest of the job worktree command.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutWorktreeOf, makeJobWorktreeCommand, repoCheckoutOf } from '../../src/executors/herdr/job-worktree.ts';
import { reapArgv } from '../../src/client/server.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';
import { GIT_ENV, ID, git, repository, sh } from './job-worktree-support.ts';

// Issue #431: a lane runs jobs of any repository one after another. A work tree that is the top of another
// repository never gives a job that repository: the job's own is cloned into the work tree's scratch dir,
// `<work tree>/.hopper-scratch/repos/<owner>/<name>`, which git ignores, and the job gets a worktree of it.
describe('a work tree that is another repository (issue #431)', () => {
  function twoRepositories(): { root: string; tree: string; app: string; lib: string } {
    const { root, tree, origin } = repository();
    mkdirSync(join(root, 'acme'));
    const app = join(root, 'acme', 'app.git');
    const lib = join(root, 'acme', 'lib.git');
    git(root, 'clone', '--quiet', '--bare', origin, app);
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', lib);
    const seed = join(root, 'lib-seed');
    git(root, 'clone', '--quiet', lib, seed);
    writeFileSync(join(seed, 'lib.txt'), 'lib\n');
    git(seed, 'add', 'lib.txt');
    git(seed, 'commit', '--quiet', '-m', 'lib');
    git(seed, 'push', '--quiet', 'origin', 'main');
    return { root, tree, app, lib };
  }

  it('clones the job\'s repository into the work tree\'s scratch dir, makes the job a worktree of that checkout, and leaves the work tree untouched', () => {
    const { tree, app } = twoRepositories();
    const before = git(tree, 'rev-parse', 'HEAD');
    const checkout = repoCheckoutOf(tree, 'acme/app');
    expect(checkout).toBe(`${tree}/.hopper-scratch/repos/acme/app`);
    const path = checkoutWorktreeOf(tree, ID, 'acme/app');
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-other\n${path}\n`);
    expect(git(checkout, 'remote', 'get-url', 'origin')).toBe(app);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(app, 'rev-parse', 'main'));
    expect(git(checkout, 'worktree', 'list')).toContain(path);
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(tree, 'status', '--porcelain')).toBe('');
  });

  it('one lane, two jobs from two repositories back to back: each runs in a worktree of its own repository, never the other\'s', () => {
    const { tree, app, lib } = twoRepositories();
    const second = 'abcdef12-0000-0000-0000-000000000002';
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app }))).toContain('hopper-job-worktree-other');
    mkdirSync(join(tree, '.hopper-scratch', second), { recursive: true });
    expect(sh(tree, makeJobWorktreeCommand(tree, second, { repo: 'acme/lib', url: lib }))).toContain('hopper-job-worktree-other');
    const first = checkoutWorktreeOf(tree, ID, 'acme/app');
    const next = checkoutWorktreeOf(tree, second, 'acme/lib');
    expect(git(first, 'remote', 'get-url', 'origin')).toBe(app);
    expect(git(next, 'remote', 'get-url', 'origin')).toBe(lib);
    expect(existsSync(join(next, 'lib.txt'))).toBe(true);
    expect(existsSync(join(first, 'lib.txt'))).toBe(false);
  });

  it('a later job of that repository fetches the checkout there instead of cloning it again', () => {
    const { tree, app } = twoRepositories();
    sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app }));
    const second = 'abcdef12-0000-0000-0000-000000000002';
    mkdirSync(join(tree, '.hopper-scratch', second), { recursive: true });
    expect(sh(tree, makeJobWorktreeCommand(tree, second, { repo: 'acme/app', url: app }))).toContain('hopper-job-worktree-other');
    expect(git(repoCheckoutOf(tree, 'acme/app'), 'worktree', 'list')).toContain(checkoutWorktreeOf(tree, second, 'acme/app'));
  });

  it('a checkout there of another repository is never used: unmade, with why', () => {
    const { root, tree, app } = twoRepositories();
    mkdirSync(join(tree, '.hopper-scratch', 'repos', 'acme'), { recursive: true });
    git(root, 'clone', '--quiet', join(root, 'acme', 'lib.git'), repoCheckoutOf(tree, 'acme/app'));
    const out = sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app }));
    expect(out).toContain('is not a checkout of acme/app');
    expect(out).toContain('hopper-job-worktree-unmade');
  });

  it('job worktrees off: the work tree is used as it is, nothing cloned', () => {
    const { tree, app } = twoRepositories();
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app, worktrees: false }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-none\n${tree}\n`);
    expect(existsSync(join(tree, '.hopper-scratch', 'repos'))).toBe(false);
  });

  it('the reap removes the job\'s worktree of the checkout, and keeps the checkout for the next job', () => {
    const { tree, app } = twoRepositories();
    sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app }));
    const [file, ...args] = reapArgv(ID, jobScratchOf(tree, ID));
    const r = spawnSync(file!, args, { cwd: tree, env: GIT_ENV, encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toContain('hopper-reaped');
    expect(existsSync(jobScratchOf(tree, ID))).toBe(false);
    expect(git(repoCheckoutOf(tree, 'acme/app'), 'worktree', 'list')).not.toContain(checkoutWorktreeOf(tree, ID, 'acme/app'));
  });
});
