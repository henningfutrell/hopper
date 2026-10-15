// The reap that ends a job worktree (issues #379, #401, #1103, #1188), run for real as test/herdr/job-worktree.test.ts runs the
// job worktree command: sh, the machine's own git, the origin a bare repository beside the work tree.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobWorktreeOf, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { reapArgv } from '../../src/client/reap.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';

import { GIT_ENV, ID, git, repository, sh } from './job-worktree-support.ts';

describe('the reap ends a job worktree (issues #379, #401)', () => {
  function made(): { tree: string; path: string; reap: () => string } {
    const { tree } = repository();
    const path = jobWorktreeOf(tree, ID);
    sh(tree, makeJobWorktreeCommand(tree, ID));
    const reap = (): string => {
      const [file, ...args] = reapArgv(ID, jobScratchOf(tree, ID));
      const r = spawnSync(file!, args, { cwd: tree, env: GIT_ENV, encoding: 'utf8' });
      return `${r.stdout}${r.stderr}`;
    };
    return { tree, path, reap };
  }

  it('removes a worktree with nothing uncommitted and nothing unpushed, with the scratch dir, and its repository keeps no entry for it', () => {
    const { tree, path, reap } = made();
    expect(reap()).toContain('hopper-reaped');
    expect(existsSync(jobScratchOf(tree, ID))).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
  });

  it('leaves another job\'s worktree beside it (issue #1103)', () => {
    const { tree, reap } = made();
    const other = 'abcdef12-0000-0000-0000-000000000003';
    sh(tree, makeJobWorktreeCommand(tree, other));
    reap();
    expect(existsSync(jobWorktreeOf(tree, other))).toBe(true);
  });

  it('removes a job worktree and scratch dir of the layout before issue #1188, then the rest of that layout, and git forgets the worktree', () => {
    const { tree } = repository();
    const old = 'abcdef12-0000-0000-0000-000000000005';
    const scratch = join(tree, '.hopper-scratch', old);
    const oldTree = join(tree, 'workspace', 'worktrees', `tree-${old}`);
    mkdirSync(join(tree, '.hopper-scratch', 'deps', 'abc'), { recursive: true });
    mkdirSync(join(tree, '.hopper-scratch', 'repos', 'acme', 'app.git'), { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(tree, '.hopper-scratch', '.gitignore'), '*\n');
    git(tree, 'worktree', 'add', '--quiet', '--detach', oldTree, 'HEAD');
    const [file, ...args] = reapArgv(old, scratch);
    expect(spawnSync(file!, args, { cwd: tree, env: GIT_ENV, encoding: 'utf8' }).stdout).toContain('hopper-reaped');
    expect(existsSync(oldTree)).toBe(false);
    expect(existsSync(join(tree, '.hopper-scratch'))).toBe(false);
    expect(existsSync(join(tree, 'workspace', 'worktrees'))).toBe(false);
    expect(git(tree, 'worktree', 'list')).not.toContain(oldTree);
  });

  it('keeps what the layout before left while a job\'s work there is kept; the reap of a job of the new layout removes none of it', () => {
    const { tree, reap } = made();
    const old = 'abcdef12-0000-0000-0000-000000000006';
    const oldTree = join(tree, 'workspace', 'worktrees', `tree-${old}`);
    git(tree, 'worktree', 'add', '--quiet', '--detach', oldTree, 'HEAD');
    writeFileSync(join(oldTree, 'x.txt'), 'x\n');
    mkdirSync(join(tree, '.hopper-scratch', 'deps'), { recursive: true });
    reap();
    expect(existsSync(join(oldTree, 'x.txt'))).toBe(true);
    expect(existsSync(join(tree, '.hopper-scratch', 'deps'))).toBe(true);
  });

  it('removes it once the branch the job made is pushed, and with ignored build output in it', () => {
    const { tree, path, reap } = made();
    git(path, 'switch', '--quiet', '-c', 'fix');
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
    git(path, 'add', '.gitignore');
    git(path, 'commit', '--quiet', '-m', 'fix');
    git(path, 'push', '--quiet', '-u', 'origin', 'fix');
    mkdirSync(join(path, 'node_modules'));
    writeFileSync(join(path, 'node_modules', 'x.js'), '\n');
    expect(reap()).not.toContain('hopper-kept');
    expect(existsSync(path)).toBe(false);
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
  });

  it('keeps it, and names it, while a commit in it is not pushed', () => {
    const { path, reap } = made();
    git(path, 'switch', '--quiet', '-c', 'local-only');
    writeFileSync(join(path, 'x.txt'), 'x\n');
    git(path, 'add', 'x.txt');
    git(path, 'commit', '--quiet', '-m', 'x');
    expect(reap()).toContain(`hopper-kept ${path}`);
    expect(existsSync(join(path, 'x.txt'))).toBe(true);
  });

  it('keeps it while a file in it is changed', () => {
    const { path, reap } = made();
    writeFileSync(join(path, 'a.txt'), 'changed\n');
    expect(reap()).toContain(`hopper-kept ${path}`);
    expect(existsSync(path)).toBe(true);
  });
});
