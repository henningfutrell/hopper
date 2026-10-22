// A stash is work (issue #2494), run for real: the reap keeps a clean, pushed checkout that holds a stash, and names no
// tip for it, so the hopper never reads it as pushed. A worktree shares its repository's stash: it holds only a stash made
// on its own HEAD.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-2494-abcdef';

let root: string;
let scratch: string;
let main: string;
let tree: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

const commit = (dir: string, name: string, text: string): string => {
  writeFileSync(join(dir, name), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD');
};

// A change in $dir to a file it tracks, put on the stash: the checkout is clean after.
const stash = (dir: string): void => {
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  git(dir, 'stash', 'push', '-q', '-m', 'job work');
};

const reap = (): string => {
  const [file, ...args] = reapArgv(JOB, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-stash-'));
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  main = join(root, 'main');
  git(root, 'clone', '-q', remote, main);
  git(main, 'checkout', '-q', '-b', 'main');
  commit(main, 'a.txt', 'a\n');
  git(main, 'push', '-q', 'origin', 'main');
  tree = join(scratch, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'issue-1', tree, 'origin/main');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a stash is work (issue #2494)', () => {
  it('a clean, pushed worktree with a stash made in it: kept, with no tip', () => {
    stash(tree);
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(readReap(reap())).toEqual({ kept: [tree] });
    expect(existsSync(tree)).toBe(true);
  });

  it('a clean, pushed worktree with a commit the hopper pushed and a stash: kept, with no tip', () => {
    commit(tree, 'b.txt', 'b\n');
    stash(tree);
    expect(readReap(reap())).toEqual({ kept: [tree] });
  });

  it('a clean, pushed worktree whose repository has a stash made on another commit: removed', () => {
    commit(main, 'c.txt', 'c\n');
    stash(main);
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
  });

  it('a clean, pushed clone in the scratch dir with a stash: kept, with no tip', () => {
    rmSync(tree, { recursive: true, force: true });
    git(main, 'worktree', 'prune');
    const clone = join(scratch, 'clone');
    git(root, 'clone', '-q', join(root, 'remote.git'), clone);
    stash(clone);
    expect(readReap(reap())).toEqual({ kept: [clone] });
    expect(existsSync(clone)).toBe(true);
  });

  it('a clean, pushed clone with no stash: removed', () => {
    rmSync(tree, { recursive: true, force: true });
    git(main, 'worktree', 'prune');
    git(root, 'clone', '-q', join(root, 'remote.git'), join(scratch, 'clone'));
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
  });
});
