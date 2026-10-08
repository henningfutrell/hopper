// The job worktree command (issue #379), and the reap that ends it (issue #401), run for real: the
// pane's shell is sh here, the git is the machine's own, the origin a bare repository beside the work
// tree. Nothing is faked: what these commands do to a repository is what they do in a job's pane.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutWorktreeOf, jobWorktreeOf, jobWorktreeOutcome, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { reapArgv } from '../../src/client/server.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';

const ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();

/** Runs the command as the pane's shell would, then `after` in the same shell; what it printed. */
function sh(cwd: string, command: string, after = ''): string {
  // What the scratch command did first: the job's scratch dir, the scratch dirs ignored.
  mkdirSync(jobScratchOf(cwd, ID), { recursive: true });
  writeFileSync(join(cwd, '.hopper-scratch', '.gitignore'), '*\n');
  const r = spawnSync('sh', ['-c', `${command}${after ? `\n${after}` : ''}`], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

/** A clone of a bare origin, with one commit on main, and the origin one commit ahead of it. */
function repository(): { root: string; tree: string; origin: string } {
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
  it('makes the job its own git worktree of the work tree in its scratch dir, detached at the remote default branch as just fetched, and enters it', () => {
    const { tree, origin } = repository();
    const path = jobWorktreeOf(tree, ID);
    expect(path).toBe(`${tree}/.hopper-scratch/${ID}/tree`);
    const out = sh(tree, makeJobWorktreeCommand(tree, ID), 'pwd');
    expect(out).toBe(`hopper-worktree-running\nhopper-job-worktree-made\n${path}\n`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path }).status).not.toBe(0);
    expect(git(tree, 'worktree', 'list')).toContain(path);
  });

  it('leaves the work tree untouched: its branch, its files, and a clean status', () => {
    const { tree } = repository();
    const before = git(tree, 'rev-parse', 'HEAD');
    sh(tree, makeJobWorktreeCommand(tree, ID));
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(git(jobWorktreeOf(tree, ID), 'status', '--porcelain')).toBe('');
  });

  it('makes no worktree when the work tree is not the top of a git repository: a plain directory, or one inside a repository', () => {
    const { root, tree } = repository();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(sh(plain, makeJobWorktreeCommand(plain, ID), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-none\n${plain}\n`);
    const inner = join(tree, 'sub');
    mkdirSync(inner);
    expect(sh(inner, makeJobWorktreeCommand(inner, ID))).toBe('hopper-worktree-running\nhopper-job-worktree-none\n');
    expect(existsSync(jobWorktreeOf(inner, ID))).toBe(false);
  });

  it('starts from HEAD when the repository has no remote', () => {
    const { root } = repository();
    const lone = join(root, 'lone');
    git(root, 'init', '--quiet', '--initial-branch=main', lone);
    writeFileSync(join(lone, 'c.txt'), 'c\n');
    git(lone, 'add', 'c.txt');
    git(lone, 'commit', '--quiet', '-m', 'c');
    const path = jobWorktreeOf(lone, ID);
    expect(sh(lone, makeJobWorktreeCommand(lone, ID))).toContain('hopper-job-worktree-made');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(lone, 'rev-parse', 'HEAD'));
  });

  it('enters the worktree an earlier run of the job left, as it is', () => {
    const { tree } = repository();
    const path = jobWorktreeOf(tree, ID);
    sh(tree, makeJobWorktreeCommand(tree, ID));
    writeFileSync(join(path, 'wip.txt'), 'wip\n');
    expect(sh(tree, makeJobWorktreeCommand(tree, ID), 'pwd')).toContain(`hopper-job-worktree-made\n${path}\n`);
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
  });

  it('says unmade, with what git said, when the worktree cannot be made', () => {
    const { tree } = repository();
    const path = jobWorktreeOf(tree, ID);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'in-the-way'), 'x\n');
    const out = sh(tree, makeJobWorktreeCommand(tree, ID));
    expect(out).toContain('hopper-job-worktree-unmade');
    expect(out).toContain('already exists');
  });

  it('a path with a quote in it', () => {
    const { root } = repository();
    const odd = join(root, "it's here");
    git(root, 'clone', '--quiet', join(root, 'origin.git'), odd);
    expect(sh(odd, makeJobWorktreeCommand(odd, ID))).toContain('hopper-job-worktree-made');
  });
});

// Issue #361: a work tree that is no repository (a machine's, the jobs directory by default) gets the job's
// repository: fetched in `<work tree>/<name>`, or cloned there the first time, and the job's worktree made of
// it. A local bare repository at `<root>/acme/app.git` stands in for GitHub.
describe('the job\'s repository in a work tree that is no repository (issue #361)', () => {
  function plainTree(): { root: string; plain: string; origin: string; url: string } {
    const { root, origin } = repository();
    const url = join(root, 'acme', 'app.git');
    mkdirSync(join(root, 'acme'));
    git(root, 'clone', '--quiet', '--bare', origin, url);
    const plain = join(root, 'jobs');
    mkdirSync(plain);
    return { root, plain, origin, url };
  }
  const checkout = (plain: string, url: string, worktrees = true) => makeJobWorktreeCommand(plain, ID, { repo: 'acme/app', url, worktrees });

  it('clones it into <work tree>/<name> the first time, makes the job its own worktree of that checkout, and enters it', () => {
    const { plain, url } = plainTree();
    const path = checkoutWorktreeOf(plain, ID, 'acme/app');
    expect(path).toBe(`${plain}/.hopper-scratch/${ID}/app`);
    expect(sh(plain, checkout(plain, url), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-checkout\n${path}\n`);
    expect(git(join(plain, 'app'), 'remote', 'get-url', 'origin')).toBe(url);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(url, 'rev-parse', 'main'));
    expect(git(join(plain, 'app'), 'worktree', 'list')).toContain(path);
    expect(readdirSync(plain).sort()).toEqual(['.hopper-scratch', 'app']);
  });

  it('a later job fetches the checkout there instead: its worktree starts at what the remote has now', () => {
    const { root, plain, url } = plainTree();
    sh(plain, checkout(plain, url));
    const ahead = join(root, 'ahead');
    git(root, 'clone', '--quiet', url, ahead);
    writeFileSync(join(ahead, 'c.txt'), 'three\n');
    git(ahead, 'add', 'c.txt');
    git(ahead, 'commit', '--quiet', '-m', 'three');
    git(ahead, 'push', '--quiet', 'origin', 'main');
    const next = 'abcdef12-0000-0000-0000-000000000002';
    mkdirSync(join(plain, '.hopper-scratch', next), { recursive: true });
    const out = sh(plain, makeJobWorktreeCommand(plain, next, { repo: 'acme/app', url }), 'pwd');
    expect(out).toBe(`hopper-worktree-running\nhopper-job-worktree-checkout\n${checkoutWorktreeOf(plain, next, 'acme/app')}\n`);
    expect(git(checkoutWorktreeOf(plain, next, 'acme/app'), 'rev-parse', 'HEAD')).toBe(git(url, 'rev-parse', 'main'));
  });

  it('a directory of that name holding another repository is never used: unmade, with why', () => {
    const { root, plain, url } = plainTree();
    git(root, 'clone', '--quiet', join(root, 'origin.git'), join(plain, 'app'));
    const out = sh(plain, checkout(plain, url));
    expect(out).toContain('is not a checkout of acme/app');
    expect(out).toContain('hopper-job-worktree-unmade');
  });

  it('a clone that fails: unmade, with what git said, and nothing left behind', () => {
    const { root, plain } = plainTree();
    const out = sh(plain, checkout(plain, join(root, 'acme', 'missing.git')));
    expect(out).toContain('hopper-job-worktree-unmade');
    expect(readdirSync(plain).filter((f) => f !== '.hopper-scratch')).toEqual([]);
  });

  it('job worktrees off: the checkout is cloned, and the shell stays in the work tree', () => {
    const { plain, url } = plainTree();
    expect(sh(plain, checkout(plain, url, false), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-none\n${plain}\n`);
    expect(existsSync(join(plain, 'app', '.git'))).toBe(true);
  });

  it('a work tree that is itself a repository gets no clone in it: its own job worktree, as before', () => {
    const { root, tree } = repository();
    const url = join(root, 'acme', 'app.git');
    expect(sh(tree, makeJobWorktreeCommand(tree, ID, { repo: 'acme/app', url }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-made\n${jobWorktreeOf(tree, ID)}\n`);
    expect(existsSync(join(tree, 'app'))).toBe(false);
  });
});

// Issue #518: typed into a zsh with busy start-up files, the command of many lines was lost or mangled. It is
// one line now, so a shell takes it as one command whatever it does with a line break, and it says first that it runs.
describe('the job worktree command, typed into any shell (issue #518)', () => {
  it('is one line', () => {
    for (const o of [{}, { repo: 'acme/app' }, { repo: 'acme/app', worktrees: false }]) expect(makeJobWorktreeCommand('/w/tree', ID, o)).not.toMatch(/[\r\n]/);
  });

  for (const shell of ['bash', 'zsh'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0)) {
    it(`runs in ${shell} as it does in sh: it says it runs, makes the worktree and enters it`, () => {
      const { tree } = repository();
      mkdirSync(jobScratchOf(tree, ID), { recursive: true });
      writeFileSync(join(tree, '.hopper-scratch', '.gitignore'), '*\n');
      const r = spawnSync(shell, [...(shell === 'zsh' ? ['-f'] : ['--noprofile', '--norc']), '-c', `${makeJobWorktreeCommand(tree, ID)}; pwd`], { cwd: tree, env: GIT_ENV, encoding: 'utf8' });
      expect(`${r.stdout}${r.stderr}`).toBe(`hopper-worktree-running\nhopper-job-worktree-made\n${jobWorktreeOf(tree, ID)}\n`);
    });
  }

  it('run again, the worktree there: entered as it is, the origin not fetched', () => {
    const { tree, origin } = repository();
    sh(tree, makeJobWorktreeCommand(tree, ID));
    const before = git(tree, 'rev-parse', 'refs/remotes/origin/main');
    git(join(origin, '..', 'other'), 'commit', '--quiet', '--allow-empty', '-m', 'three');
    git(join(origin, '..', 'other'), 'push', '--quiet', 'origin', 'main');
    expect(sh(tree, makeJobWorktreeCommand(tree, ID), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-made\n${jobWorktreeOf(tree, ID)}\n`);
    expect(git(tree, 'rev-parse', 'refs/remotes/origin/main')).toBe(before);
  });

  it('its outcome is read wherever it stands on its line, and never from the command\'s own echo', () => {
    expect(jobWorktreeOutcome('$ cd x\nuser@box:~/x$ hopper-job-worktree-made\n$ ')).toBe('made');
    expect(jobWorktreeOutcome('hopper-job-worktree-checkout\nhopper-job-worktree-unmade')).toBe('unmade');
    expect(jobWorktreeOutcome(`$ ${makeJobWorktreeCommand('/w/tree', ID)}\nhopper-worktree-running`)).toBeUndefined();
  });
});

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
    expect(git(tree, 'worktree', 'list')).not.toContain(path);
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
