// The reap that discards an ended job's kept work (issue #1010), run for real: a real shell and real git repositories
// in the job's scratch dir, removed whatever they hold.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';
import { withoutUse } from '../support/reap-said.ts';

const JOB = 'job-401-abcdef';

let root: string;
let scratch: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

/** A bare remote with one commit on main, and a clone of it at `dir`. */
function cloneAt(dir: string): string {
  const remote = join(root, `remote-${Math.random().toString(36).slice(2)}.git`);
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-'));
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the reap that discards kept work (issue #1010): a person said the work is not wanted', () => {
  const discarding = (dir = scratch): string => { const [file, ...args] = reapArgv(JOB, dir, false, true); return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 }); };

  it('removes the scratch dir with its uncommitted and unpushed work, and the worktree entry in its repository', () => {
    const dirty = join(scratch, 'dirty');
    cloneAt(dirty);
    writeFileSync(join(dirty, 'a.txt'), 'changed\n');
    const main = join(root, 'main');
    cloneAt(main);
    const ahead = join(scratch, 'ahead');
    git(main, 'worktree', 'add', '-q', '-b', 'ahead', ahead, 'origin/main');
    writeFileSync(join(ahead, 'd.txt'), 'd\n');
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-q', '-m', 'd');
    writeFileSync(join(ahead, 'e.txt'), 'e\n');
    expect(withoutUse(readReap(discarding()))).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
    expect(git(main, 'worktree', 'list')).not.toContain(ahead);
    expect(existsSync(join(main, 'a.txt'))).toBe(true);
  });

  it('touches nothing but a job scratch dir', () => {
    const elsewhere = join(root, 'work');
    writeFileSync(join(elsewhere, 'keep.txt'), 'x');
    expect(withoutUse(readReap(discarding(elsewhere)))).toEqual({ kept: [] });
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true);
  });
});
