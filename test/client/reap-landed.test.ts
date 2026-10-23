// The reap's rule for work already on a remote under other commits (issue #1187), run for real: real git repositories,
// a bare remote, and another clone that lands the job's work by a squash, a rebase, or commits made again.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-1187-abcdef';

let root: string;
let scratch: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

/** A bare remote with one commit on main, and a clone of it at `dir`. */
function cloneAt(dir: string): string {
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'a');
  git(seed, 'push', '-q', remote, 'main');
  git(root, 'clone', '-q', remote, dir);
  return remote;
}

/** The tips the reap names for a clean kept checkout (issue #2087): its HEAD. */
const tipsOf = (dir: string): { tips: Record<string, string[]> } => ({ tips: { [dir]: [git(dir, 'rev-parse', 'HEAD').trim()] } });

const reap = (): string => {
  const [file, ...args] = reapArgv(JOB, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-landed-'));
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('work already on a remote under other commits (issue #1187): not kept', () => {
  const commit = (dir: string, files: Record<string, string>, message: string): void => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
  };
  /** The job's work: two commits, a changed file and two new ones. */
  const work = (dir: string, again = ''): void => {
    commit(dir, { 'b.txt': 'b\n' }, `b${again}`);
    commit(dir, { 'a.txt': 'a2\n', 'c.txt': 'c\n' }, `c${again}`);
  };

  let main: string;
  let other: string;
  let tree: string;
  beforeEach(() => {
    main = join(root, 'main');
    const remote = cloneAt(main);
    other = join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    tree = join(scratch, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'issue-1', tree, 'origin/main');
    work(tree);
  });
  /** Another clone lands something on the remote's main, after an unrelated change; the job's repository fetches it. */
  let landed = 0;
  const land = (change: (dir: string) => void): void => {
    landed += 1;
    commit(other, { 'z.txt': `z${landed}\n` }, 'z');
    change(other);
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    git(main, 'fetch', '-q', 'origin');
  };

  it('its commits squash-merged to the default branch', () => {
    land((d) => commit(d, { 'a.txt': 'a2\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, 'squashed'));
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(tree)).toBe(false);
  });

  it('its commits rebased onto the default branch, and a later change to the same file there', () => {
    land((d) => { work(d); commit(d, { 'b.txt': 'b, later\n' }, 'later'); });
    expect(readReap(reap())).toEqual({ kept: [] });
  });

  it('its commits made again by another job, on a branch not merged', () => {
    git(other, 'checkout', '-q', '-b', 'issue-1-again');
    work(other, ' again');
    git(other, 'push', '-q', 'origin', 'issue-1-again');
    git(main, 'fetch', '-q', 'origin');
    expect(readReap(reap())).toEqual({ kept: [] });
  });

  it('its own branch rebased locally onto a newer default branch, once that branch was pushed', () => {
    git(tree, 'push', '-q', 'origin', 'issue-1');
    land(() => undefined);
    git(tree, 'rebase', '-q', 'origin/main');
    expect(readReap(reap())).toEqual({ kept: [] });
  });

  it('kept when the remote has only part of it, or the same files with other content', () => {
    land((d) => commit(d, { 'b.txt': 'b\n' }, 'part'));
    expect(readReap(reap())).toEqual({ kept: [tree], ...tipsOf(tree), reasons: { [tree]: ['unpushed'] } });
    land((d) => commit(d, { 'a.txt': 'a3\n', 'c.txt': 'c\n' }, 'other content'));
    expect(readReap(reap())).toEqual({ kept: [tree], ...tipsOf(tree), reasons: { [tree]: ['unpushed'] } });
  });

  it('kept when it adds work of its own on top of what landed', () => {
    land((d) => commit(d, { 'a.txt': 'a2\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, 'squashed'));
    commit(tree, { 'd.txt': 'd\n' }, 'd');
    expect(readReap(reap())).toEqual({ kept: [tree], ...tipsOf(tree), reasons: { [tree]: ['unpushed'] } });
  });

  it('a merge of its own not on the remote keeps it, though each patch is there', () => {
    git(other, 'checkout', '-q', '-b', 'side');
    commit(other, { 'e.txt': 'e\n' }, 'e');
    git(other, 'push', '-q', 'origin', 'side');
    git(main, 'fetch', '-q', 'origin');
    git(tree, 'merge', '-q', '--no-edit', 'origin/side');
    git(tree, 'push', '-q', 'origin', 'HEAD^1:refs/heads/issue-1');
    git(main, 'fetch', '-q', 'origin');
    expect(readReap(reap())).toEqual({ kept: [tree], ...tipsOf(tree), reasons: { [tree]: ['unpushed'] }, pushed: [tree] });
  });
});
