// The job worktree command (issue #379), and the reap that ends it (issue #401), run for real: the
// pane's shell is sh here, the git is the machine's own, the origin a bare repository beside the work
// tree. Nothing is faked: what these commands do to a repository is what they do in a job's pane.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobWorktreeOf, jobWorktreeOutcome, makeJobWorktreeCommand, mirrorOf, mirrorWorktreeOf, passFetchKey, passFetches } from '../../src/executors/herdr/job-worktree.ts';
import { reapArgv } from '../../src/client/server.ts';
import { jobScratchOf } from '../../src/executors/herdr/start.ts';

import { GIT_ENV, ID, git, repository, served, sh } from './job-worktree-support.ts';

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

  it('fetches the remote\'s default branch only, pruned (issue #858): another branch on the remote is not fetched', () => {
    const { root, tree, origin } = repository();
    git(tree, 'remote', 'set-head', 'origin', 'main');
    const other = join(root, 'other');
    git(other, 'push', '--quiet', 'origin', 'HEAD:someone-elses');
    sh(tree, makeJobWorktreeCommand(tree, ID));
    expect(git(tree, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(origin, 'rev-parse', 'main'));
    expect(git(tree, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).not.toContain('someone-elses');
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

// Issues #361, #858: a work tree that is no repository (a machine's, the jobs directory by default) gets the job's
// repository's mirror: a bare, blobless clone in `<work tree>/.hopper-scratch/repos/<owner>/<name>.git`, fetched for the
// default branch only, and the job's worktree made of it. A local bare repository at `<root>/acme/app.git`, served over
// a file URL with blob filters allowed, stands in for GitHub.
describe('the job\'s repository in a work tree that is no repository (issues #361, #858)', () => {
  function plainTree(): { root: string; plain: string; origin: string; bare: string; url: string } {
    const { root, origin } = repository();
    const bare = join(root, 'acme', 'app.git');
    mkdirSync(join(root, 'acme'));
    git(root, 'clone', '--quiet', '--bare', origin, bare);
    const plain = join(root, 'jobs');
    mkdirSync(plain);
    return { root, plain, origin, bare, url: served(bare) };
  }
  const checkout = (plain: string, url: string, worktrees = true) => makeJobWorktreeCommand(plain, ID, { repo: 'acme/app', url, worktrees });
  const NEXT = 'abcdef12-0000-0000-0000-000000000002';
  /** A commit on the origin's `branch`, pushed from a clone of it. */
  function pushTo(root: string, bare: string, branch: string): string {
    const ahead = join(root, `ahead-${branch}`);
    if (!existsSync(ahead)) git(root, 'clone', '--quiet', bare, ahead);
    git(ahead, 'commit', '--quiet', '--allow-empty', '-m', branch);
    git(ahead, 'push', '--quiet', 'origin', `HEAD:${branch}`);
    return git(ahead, 'rev-parse', 'HEAD');
  }

  it('clones its mirror into the work tree\'s scratch dir the first time, makes the job its own worktree of it, and enters it', () => {
    const { plain, bare, url } = plainTree();
    const path = mirrorWorktreeOf(plain, ID, 'acme/app');
    const mirror = mirrorOf(plain, 'acme/app');
    expect(path).toBe(`${plain}/.hopper-scratch/${ID}/app`);
    expect(mirror).toBe(`${plain}/.hopper-scratch/repos/acme/app.git`);
    expect(sh(plain, checkout(plain, url), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-mirror\n${path}\n`);
    expect(git(mirror, 'remote', 'get-url', 'origin')).toBe(url);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));
    expect(git(mirror, 'worktree', 'list')).toContain(path);
    expect(readdirSync(plain).sort()).toEqual(['.hopper-scratch']);
  });

  it('the mirror is bare and blobless, its branches the remote\'s (refs/remotes/origin), and the job\'s files are there to work on', () => {
    const { plain, url } = plainTree();
    sh(plain, checkout(plain, url));
    const mirror = mirrorOf(plain, 'acme/app');
    expect(git(mirror, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(mirror, 'config', 'remote.origin.partialclonefilter')).toBe('blob:none');
    expect(git(mirror, 'config', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(git(mirror, 'for-each-ref', '--format=%(refname)')).toBe('refs/remotes/origin/HEAD\nrefs/remotes/origin/main');
    const path = mirrorWorktreeOf(plain, ID, 'acme/app');
    expect(readdirSync(path).sort()).toEqual(['.git', 'a.txt', 'b.txt']);
  });

  it('a later job fetches the mirror instead, the default branch only: its worktree starts at what the remote has now', () => {
    const { root, plain, bare, url } = plainTree();
    sh(plain, checkout(plain, url));
    const now = pushTo(root, bare, 'main');
    pushTo(root, bare, 'someone-elses');
    mkdirSync(join(plain, '.hopper-scratch', NEXT), { recursive: true });
    const out = sh(plain, makeJobWorktreeCommand(plain, NEXT, { repo: 'acme/app', url }), 'pwd');
    expect(out).toBe(`hopper-worktree-running\nhopper-job-worktree-mirror\n${mirrorWorktreeOf(plain, NEXT, 'acme/app')}\n`);
    expect(git(mirrorWorktreeOf(plain, NEXT, 'acme/app'), 'rev-parse', 'HEAD')).toBe(now);
    expect(git(mirrorOf(plain, 'acme/app'), 'for-each-ref', '--format=%(refname)')).not.toContain('someone-elses');
  });

  it('a later job in the same sync pass fetches nothing (issue #858 part 2): its worktree starts at what the pass fetched', () => {
    const { root, plain, bare, url } = plainTree();
    const first = git(bare, 'rev-parse', 'main');
    sh(plain, checkout(plain, url));
    pushTo(root, bare, 'main');
    mkdirSync(join(plain, '.hopper-scratch', NEXT), { recursive: true });
    const out = sh(plain, makeJobWorktreeCommand(plain, NEXT, { repo: 'acme/app', url, fetch: false }), 'pwd');
    expect(out).toBe(`hopper-worktree-running\nhopper-job-worktree-mirror\n${mirrorWorktreeOf(plain, NEXT, 'acme/app')}\n`);
    expect(git(mirrorWorktreeOf(plain, NEXT, 'acme/app'), 'rev-parse', 'HEAD')).toBe(first);
    expect(git(mirrorOf(plain, 'acme/app'), 'rev-parse', 'refs/remotes/origin/main')).toBe(first);
  });

  it('an extra job adds only its worktree: one mirror, nothing cloned again', () => {
    const { plain, url } = plainTree();
    sh(plain, checkout(plain, url));
    const mirror = mirrorOf(plain, 'acme/app');
    const objects = git(mirror, 'count-objects', '-v');
    mkdirSync(join(plain, '.hopper-scratch', NEXT), { recursive: true });
    sh(plain, makeJobWorktreeCommand(plain, NEXT, { repo: 'acme/app', url }));
    expect(readdirSync(join(plain, '.hopper-scratch', 'repos', 'acme'))).toEqual(['app.git']);
    expect(git(mirror, 'count-objects', '-v')).toBe(objects);
    expect(git(mirror, 'worktree', 'list').split('\n')).toHaveLength(3);
  });

  it('what the job pushed from its worktree is the remote\'s branch in the mirror, so the reap reads it as pushed', () => {
    const { plain, url } = plainTree();
    sh(plain, checkout(plain, url));
    const path = mirrorWorktreeOf(plain, ID, 'acme/app');
    git(path, 'switch', '--quiet', '-c', 'fix');
    git(path, 'commit', '--quiet', '--allow-empty', '-m', 'fix');
    git(path, 'push', '--quiet', '-u', 'origin', 'fix');
    expect(git(path, 'log', '--oneline', 'HEAD', '--not', '--remotes')).toBe('');
    const [file, ...args] = reapArgv(ID, jobScratchOf(plain, ID));
    const r = spawnSync(file!, args, { cwd: plain, env: GIT_ENV, encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).not.toContain('hopper-kept');
    expect(existsSync(path)).toBe(false);
  });

  it('a mirror there of another repository is never used: unmade, with why', () => {
    const { root, plain, url } = plainTree();
    mkdirSync(join(plain, '.hopper-scratch', 'repos', 'acme'), { recursive: true });
    git(root, 'clone', '--quiet', '--bare', join(root, 'origin.git'), mirrorOf(plain, 'acme/app'));
    const out = sh(plain, checkout(plain, url));
    expect(out).toContain('is not a mirror of acme/app');
    expect(out).toContain('hopper-job-worktree-unmade');
  });

  it('a clone that fails: unmade, with what git said, and nothing left behind', () => {
    const { root, plain } = plainTree();
    const out = sh(plain, checkout(plain, served(join(root, 'origin.git')).replace('origin.git', 'missing.git')));
    expect(out).toContain('hopper-job-worktree-unmade');
    expect(readdirSync(plain).filter((f) => f !== '.hopper-scratch')).toEqual([]);
    expect(readdirSync(join(plain, '.hopper-scratch', 'repos', 'acme'))).toEqual([]);
  });

  it('job worktrees off: the full checkout <work tree>/<name> is cloned, and the shell stays in the work tree', () => {
    const { plain, url } = plainTree();
    expect(sh(plain, checkout(plain, url, false), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-none\n${plain}\n`);
    expect(existsSync(join(plain, 'app', '.git'))).toBe(true);
    expect(existsSync(join(plain, '.hopper-scratch', 'repos'))).toBe(false);
  });

  it('job worktrees off: a directory of that name holding another repository is never used: unmade, with why', () => {
    const { root, plain, url } = plainTree();
    git(root, 'clone', '--quiet', join(root, 'origin.git'), join(plain, 'app'));
    const out = sh(plain, checkout(plain, url, false));
    expect(out).toContain('is not a checkout of acme/app');
    expect(out).toContain('hopper-job-worktree-unmade');
  });

  it('a work tree that is a checkout of the job\'s own repository gets no mirror: its own job worktree, as before (any case)', () => {
    const { root, bare, url } = plainTree();
    const own = join(root, 'own');
    git(root, 'clone', '--quiet', bare, own);
    expect(sh(own, makeJobWorktreeCommand(own, ID, { repo: 'Acme/App', url }), 'pwd')).toBe(`hopper-worktree-running\nhopper-job-worktree-made\n${jobWorktreeOf(own, ID)}\n`);
    expect(existsSync(join(own, '.hopper-scratch', 'repos'))).toBe(false);
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
    expect(jobWorktreeOutcome('hopper-job-worktree-mirror\nhopper-job-worktree-unmade')).toBe('unmade');
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

describe('one fetch per repository per sync pass on each machine (issue #858 part 2)', () => {
  it('a start that fetched in the newest pass leaves the next start nothing to fetch, until another pass begins', () => {
    let pass = 4;
    const fetches = passFetches(() => pass);
    const here = passFetchKey('omega', '/work/', 'Acme/App');
    expect(here).toBe(passFetchKey('omega', '/work', 'acme/app'));
    expect(fetches.fresh(here)).toBe(false);
    fetches.fetched(here);
    expect(fetches.fresh(here)).toBe(true);
    expect(fetches.fresh(passFetchKey('other', '/work', 'acme/app'))).toBe(false);
    pass = 5;
    expect(fetches.fresh(here)).toBe(false);
  });
});
