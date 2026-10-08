// The job worktree commands (issue #379), run for real: the pane's shell is sh here, the git is the
// machine's own, the origin a bare repository beside the checkout. Nothing is faked: what these
// commands do to a checkout is what they do in a job's pane.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobWorktreeOf, makeJobWorktreeCommand, removeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';

const ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/** Runs the command as the pane's shell would, then `after` in the same shell; what it printed. */
function sh(cwd: string, command: string, after = ''): string {
  const r = spawnSync('sh', ['-c', `${command}${after ? `\n${after}` : ''}`], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

/** A checkout of a bare origin, with one commit on main, and the origin one commit ahead of it. */
function checkout(): { root: string; tree: string; origin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-job-worktree-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const tree = join(root, 'tree');
  git(root, 'clone', '--quiet', origin, tree);
  writeFileSync(join(tree, 'a.txt'), 'one\n');
  git(tree, 'add', 'a.txt');
  git(tree, 'commit', '--quiet', '-m', 'one');
  git(tree, 'push', '--quiet', 'origin', 'main');
  git(root, 'clone', '--quiet', origin, join(root, 'other'));
  writeFileSync(join(root, 'other', 'b.txt'), 'two\n');
  git(join(root, 'other'), 'add', 'b.txt');
  git(join(root, 'other'), 'commit', '--quiet', '-m', 'two');
  git(join(root, 'other'), 'push', '--quiet', 'origin', 'main');
  return { root, tree, origin };
}

describe('the job worktree command (issue #379)', () => {
  it('makes the job its own git worktree of the checkout, detached at the remote default branch as just fetched, and enters it', () => {
    const { tree, origin } = checkout();
    const path = jobWorktreeOf(tree, ID);
    const out = sh(tree, makeJobWorktreeCommand(tree, path), 'pwd; printf "%s %s\\n" "$TMPDIR" "$CLAUDE_CODE_TMPDIR"');
    expect(out).toContain('hopper-job-worktree-made');
    expect(out).toContain(`${path}\n`);
    expect(out).toContain(`${path}/.hopper-scratch ${path}/.hopper-scratch`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path }).status).not.toBe(0);
    expect(git(tree, 'worktree', 'list')).toContain(path);
  });

  it('leaves the checkout untouched: its branch, its files, and a clean status', () => {
    const { tree } = checkout();
    const before = git(tree, 'rev-parse', 'HEAD');
    sh(tree, makeJobWorktreeCommand(tree, jobWorktreeOf(tree, ID)));
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(jobWorktreeOf(tree, ID), '.hopper-scratch', '.gitignore'))).toBe(true);
    expect(git(jobWorktreeOf(tree, ID), 'status', '--porcelain')).toBe('');
  });

  it('makes no worktree when the work tree is not the top of a git checkout: a plain directory, or one inside a repository', () => {
    const { root, tree } = checkout();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(sh(plain, makeJobWorktreeCommand(plain, jobWorktreeOf(plain, ID)), 'pwd')).toBe(`hopper-job-worktree-none\n${plain}\n`);
    const inner = join(tree, 'sub');
    mkdirSync(inner);
    expect(sh(inner, makeJobWorktreeCommand(inner, jobWorktreeOf(inner, ID)))).toBe('hopper-job-worktree-none\n');
    expect(existsSync(join(inner, '.hopper-jobs'))).toBe(false);
  });

  it('starts from HEAD when the checkout has no remote', () => {
    const { root } = checkout();
    const lone = join(root, 'lone');
    git(root, 'init', '--quiet', '--initial-branch=main', lone);
    writeFileSync(join(lone, 'c.txt'), 'c\n');
    git(lone, 'add', 'c.txt');
    git(lone, 'commit', '--quiet', '-m', 'c');
    const path = jobWorktreeOf(lone, ID);
    expect(sh(lone, makeJobWorktreeCommand(lone, path))).toContain('hopper-job-worktree-made');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(lone, 'rev-parse', 'HEAD'));
  });

  it('enters the worktree an earlier run of the job left, as it is', () => {
    const { tree } = checkout();
    const path = jobWorktreeOf(tree, ID);
    sh(tree, makeJobWorktreeCommand(tree, path));
    writeFileSync(join(path, 'wip.txt'), 'wip\n');
    expect(sh(tree, makeJobWorktreeCommand(tree, path), 'pwd')).toContain(`hopper-job-worktree-made\n${path}\n`);
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
  });

  it('says unmade, with what git said, when the worktree cannot be made', () => {
    const { tree } = checkout();
    const path = jobWorktreeOf(tree, ID);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'in-the-way'), 'x\n');
    const out = sh(tree, makeJobWorktreeCommand(tree, path));
    expect(out).toContain('hopper-job-worktree-unmade');
    expect(out).toContain('already exists');
  });

  it('a path with a quote in it', () => {
    const { root } = checkout();
    const odd = join(root, "it's here");
    git(root, 'clone', '--quiet', join(root, 'origin.git'), odd);
    expect(sh(odd, makeJobWorktreeCommand(odd, jobWorktreeOf(odd, ID)))).toContain('hopper-job-worktree-made');
  });
});

describe('the job worktree removal command (issue #379)', () => {
  function made(): { tree: string; path: string; origin: string } {
    const { tree, origin } = checkout();
    const path = jobWorktreeOf(tree, ID);
    sh(tree, makeJobWorktreeCommand(tree, path));
    return { tree, path, origin };
  }

  it('removes a worktree with nothing uncommitted and nothing unpushed, from inside it too', () => {
    const { tree, path } = made();
    expect(sh(path, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-removed\n');
    expect(existsSync(path)).toBe(false);
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
  });

  it('removes it with ignored build output in it, and its own scratch dir', () => {
    const { tree, path } = made();
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
    git(path, 'add', '.gitignore');
    git(path, 'commit', '--quiet', '-m', 'ignore');
    git(path, 'push', '--quiet', 'origin', 'HEAD:refs/heads/ignore');
    mkdirSync(join(path, 'node_modules'));
    writeFileSync(join(path, 'node_modules', 'x.js'), '\n');
    writeFileSync(join(path, '.hopper-scratch', 'tmp'), '\n');
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-removed\n');
    expect(existsSync(path)).toBe(false);
  });

  it('removes it, and its branch, once the branch is pushed', () => {
    const { tree, path, origin } = made();
    git(path, 'switch', '--quiet', '-c', 'fix');
    writeFileSync(join(path, 'fix.txt'), 'fix\n');
    git(path, 'add', 'fix.txt');
    git(path, 'commit', '--quiet', '-m', 'fix');
    git(path, 'push', '--quiet', '-u', 'origin', 'fix');
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-removed\n');
    expect(git(tree, 'branch', '--list', 'fix')).toBe('');
    expect(git(origin, 'branch', '--list', 'fix')).toContain('fix');
  });

  it('keeps it while a commit in it is not pushed', () => {
    const { tree, path } = made();
    git(path, 'switch', '--quiet', '-c', 'local-only');
    writeFileSync(join(path, 'x.txt'), 'x\n');
    git(path, 'add', 'x.txt');
    git(path, 'commit', '--quiet', '-m', 'x');
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-kept\n');
    expect(existsSync(join(path, 'x.txt'))).toBe(true);
    expect(git(tree, 'branch', '--list', 'local-only')).toContain('local-only');
  });

  it('keeps it while a file in it is changed or untracked', () => {
    const { tree, path } = made();
    writeFileSync(join(path, 'a.txt'), 'changed\n');
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-kept\n');
    git(path, 'checkout', '--quiet', '--', 'a.txt');
    writeFileSync(join(path, 'new.txt'), 'new\n');
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-kept\n');
    expect(existsSync(join(path, 'new.txt'))).toBe(true);
  });

  it('says removed when it is already gone, so running it twice is harmless', () => {
    const { tree, path } = made();
    sh(tree, removeJobWorktreeCommand(tree, path));
    expect(sh(tree, removeJobWorktreeCommand(tree, path))).toBe('hopper-job-worktree-removed\n');
  });
});
