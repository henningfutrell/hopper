// The commits a kept checkout holds that no remote has (issue #2087), run for real: the reap names each tip of a clean
// checkout, so the hopper can read work it pushed itself as pushed. A checkout with a change names none.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';
import { withoutUse } from '../support/reap-said.ts';

const JOB = 'job-2087-abcdef';

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

const reap = (): string => {
  const [file, ...args] = reapArgv(JOB, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-tips-'));
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

describe('the tips of kept work (issue #2087)', () => {
  it('a clean worktree with a commit no remote has: kept, with that commit as its tip', () => {
    const head = commit(tree, 'b.txt', 'b\n');
    expect(withoutUse(readReap(reap()))).toEqual({ kept: [tree], tips: { [tree]: [head] }, reasons: { [tree]: ['unpushed'] } });
  });

  it('a worktree with a change: kept, with no tip', () => {
    commit(tree, 'b.txt', 'b\n');
    writeFileSync(join(tree, 'c.txt'), 'c\n');
    expect(withoutUse(readReap(reap()))).toEqual({ kept: [tree], reasons: { [tree]: ['dirty', 'unpushed'] } });
  });

  it('a clean clone: each branch that holds work no remote has is a tip, a pushed one is not', () => {
    rmSync(tree, { recursive: true, force: true });
    git(main, 'worktree', 'prune');
    const clone = join(scratch, 'clone');
    git(root, 'clone', '-q', join(root, 'remote.git'), clone);
    const first = commit(clone, 'b.txt', 'b\n');
    git(clone, 'checkout', '-q', '-b', 'side', 'origin/main');
    const second = commit(clone, 'c.txt', 'c\n');
    expect(readReap(reap())?.tips?.[clone]?.sort()).toEqual([first, second].sort());
  });
});
