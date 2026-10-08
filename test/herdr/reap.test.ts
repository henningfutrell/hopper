// The reap command a job's pane shell runs when the job ends (issue #401), run for real: a real shell,
// real processes carrying the job's HOPPER_JOB_ID, real git repositories in the job's scratch dir.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAP_DONE, readReap, reapCommand } from '../../src/executors/herdr/reap.ts';

const JOB = 'job-401-abcdef';
const OTHER = 'job-401-other';

let root: string;
let scratch: string;
const children: ChildProcess[] = [];

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

/** A process that would outlive the job: detached, in its own session, carrying `jobId`. */
function straggler(jobId: string): ChildProcess {
  const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, HOPPER_JOB_ID: jobId } });
  p.unref();
  children.push(p);
  return p;
}

const alive = (pid: number): boolean => {
  try {
    // A zombie still answers kill 0; its state in /proc says it is gone.
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z/.test(execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' }));
  } catch {
    return false;
  }
};

/** Run the reap as the pane's shell would: that shell carries HOPPER_JOB_ID too, and must survive it. */
function reap(jobId = JOB, dir = scratch): string {
  return execFileSync('sh', ['-c', `${reapCommand(jobId, dir)}; echo shell-survived`], {
    encoding: 'utf8', env: { ...process.env, HOPPER_JOB_ID: jobId }, timeout: 20000,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-'));
  scratch = join(root, 'work', '.hopper-scratch', JOB);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  for (const c of children.splice(0)) if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

describe('the reap at job end (issue #401)', () => {
  it.runIf(existsSync('/proc/self/environ'))('stops every process carrying the job\'s HOPPER_JOB_ID, never another job\'s, and the pane shell survives', () => {
    const mine = [straggler(JOB), straggler(JOB)];
    const theirs = straggler(OTHER);
    const out = reap();
    expect(out).toContain('shell-survived');
    expect(out).toContain(REAP_DONE);
    for (const p of mine) expect(alive(p.pid!)).toBe(false);
    expect(alive(theirs.pid!)).toBe(true);
  });

  it('removes the job\'s scratch dir with its temp files and its clones whose work is pushed', () => {
    writeFileSync(join(scratch, 'tmp.txt'), 'x');
    cloneAt(join(scratch, 'repo'));
    const out = reap();
    expect(readReap(out)).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(root, 'work', '.hopper-scratch'))).toBe(true);
  });

  it('keeps the scratch dir and names each repository holding uncommitted or unpushed work', () => {
    const dirty = join(scratch, 'dirty');
    cloneAt(dirty);
    writeFileSync(join(dirty, 'a.txt'), 'changed\n');
    const ahead = join(scratch, 'nested', 'ahead');
    cloneAt(ahead);
    git(ahead, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(ahead, 'b.txt'), 'b\n');
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-q', '-m', 'b');
    git(ahead, 'checkout', '-q', 'main');
    cloneAt(join(scratch, 'clean'));
    const out = reap();
    expect(readReap(out)?.kept.sort()).toEqual([ahead, dirty].sort());
    expect(existsSync(join(scratch, 'clean'))).toBe(true);
  });

  it('removes a pushed git worktree of a repository outside the scratch dir, and its entry there', () => {
    const main = join(root, 'main');
    cloneAt(main);
    const tree = join(scratch, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'issue-1', tree, 'origin/main');
    const out = reap();
    expect(readReap(out)).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
    expect(git(main, 'worktree', 'list')).not.toContain(tree);
  });

  it('keeps a worktree whose branch has commits no remote has, though other branches of its repository do not matter', () => {
    const main = join(root, 'main');
    cloneAt(main);
    git(main, 'checkout', '-q', '-b', 'someone-elses');
    writeFileSync(join(main, 'c.txt'), 'c\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'c');
    const pushed = join(scratch, 'pushed');
    git(main, 'worktree', 'add', '-q', '-b', 'pushed', pushed, 'origin/main');
    expect(readReap(reap())).toEqual({ kept: [] });

    mkdirSync(scratch, { recursive: true });
    const ahead = join(scratch, 'ahead');
    git(main, 'worktree', 'add', '-q', '-b', 'ahead', ahead, 'origin/main');
    writeFileSync(join(ahead, 'd.txt'), 'd\n');
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-q', '-m', 'd');
    expect(readReap(reap())).toEqual({ kept: [ahead] });
  });

  it('touches nothing but a job scratch dir', () => {
    const elsewhere = join(root, 'work');
    writeFileSync(join(elsewhere, 'keep.txt'), 'x');
    expect(readReap(reap(JOB, elsewhere))).toEqual({ kept: [] });
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true);
  });

  it('reads nothing from a screen the reap has not finished on: the typed command is no output', () => {
    expect(readReap(`$ ${reapCommand(JOB, scratch)}`)).toBeUndefined();
  });
});
