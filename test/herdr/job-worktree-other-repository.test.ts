// Issue #431, run for real as test/herdr/job-worktree.test.ts runs the rest of the job worktree command.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutOf, jobWorktreeOf, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { reapArgv } from '../../src/client/server.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';
import { GIT_ENV, ID, git, repository, served, sh } from './job-worktree-support.ts';

// Issue #431: a lane runs jobs of any repository one after another. A work tree that is the top of another
// repository never gives a job that repository: the job's own repository is cloned into the work tree's workspace,
// `<work tree>/workspace/<name>` (issue #1103), which git ignores, and the job gets a worktree of it beside it.
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

  it('clones the job\'s repository into the work tree\'s workspace, makes the job a worktree of it, and leaves the work tree untouched', () => {
    const { tree, app } = twoRepositories();
    const before = git(tree, 'rev-parse', 'HEAD');
    const mirror = checkoutOf(tree, 'acme/app');
    expect(mirror).toBe(`${tree}/workspace/app`);
    const path = jobWorktreeOf(tree, ID, 'acme/app');
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: served(app) }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-checkout\n${path}\n`);
    expect(git(mirror, 'remote', 'get-url', 'origin')).toBe(served(app));
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(app, 'rev-parse', 'main'));
    expect(git(mirror, 'worktree', 'list')).toContain(path);
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(tree, 'status', '--porcelain')).toBe('');
  });

  it('one lane, two jobs from two repositories back to back: each runs in a worktree of its own repository, never the other\'s', () => {
    const { tree, app, lib } = twoRepositories();
    const second = 'abcdef12-0000-0000-0000-000000000002';
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: served(app) }))).toContain('hopper-job-worktree-checkout');
    expect(sh(tree, makeJobWorktreeCommand(tree, second, { repo: 'acme/lib', url: served(lib) }))).toContain('hopper-job-worktree-checkout');
    const first = jobWorktreeOf(tree, ID, 'acme/app');
    const next = jobWorktreeOf(tree, second, 'acme/lib');
    expect(git(first, 'remote', 'get-url', 'origin')).toBe(served(app));
    expect(git(next, 'remote', 'get-url', 'origin')).toBe(served(lib));
    expect(existsSync(join(next, 'lib.txt'))).toBe(true);
    expect(existsSync(join(first, 'lib.txt'))).toBe(false);
  });

  it('a later job of that repository fetches the checkout there instead of cloning it again', () => {
    const { tree, app } = twoRepositories();
    sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: served(app) }));
    const second = 'abcdef12-0000-0000-0000-000000000002';
    expect(sh(tree, makeJobWorktreeCommand(tree, second, { repo: 'acme/app', url: served(app) }))).toContain('hopper-job-worktree-checkout');
    expect(git(checkoutOf(tree, 'acme/app'), 'worktree', 'list')).toContain(jobWorktreeOf(tree, second, 'acme/app'));
  });

  it('a checkout there of another repository is never used: unmade, with why', () => {
    const { root, tree, app } = twoRepositories();
    mkdirSync(join(tree, 'workspace'));
    git(root, 'clone', '--quiet', join(root, 'acme', 'lib.git'), checkoutOf(tree, 'acme/app'));
    const out = sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: served(app) }));
    expect(out).toContain('is not a checkout of acme/app');
    expect(out).toContain('hopper-job-worktree-unmade');
  });

  it('job worktrees off: the work tree is used as it is, nothing cloned', () => {
    const { tree, app } = twoRepositories();
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: app, worktrees: false }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-none\n${tree}\n`);
    expect(existsSync(join(tree, 'workspace'))).toBe(false);
  });

  it('the reap removes the job\'s worktree of the checkout, and keeps the checkout for the next job', () => {
    const { tree, app } = twoRepositories();
    sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url: served(app) }));
    const [file, ...args] = reapArgv(ID, jobScratchOf(tree, ID));
    const r = spawnSync(file!, args, { cwd: tree, env: GIT_ENV, encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toContain('hopper-reaped');
    expect(existsSync(jobScratchOf(tree, ID))).toBe(false);
    expect(git(checkoutOf(tree, 'acme/app'), 'worktree', 'list')).not.toContain(jobWorktreeOf(tree, ID, 'acme/app'));
    expect(existsSync(jobWorktreeOf(tree, ID, 'acme/app'))).toBe(false);
    expect(existsSync(join(checkoutOf(tree, 'acme/app'), '.git'))).toBe(true);
    expect(git(tree, 'status', '--porcelain')).toBe('');
  });
});
