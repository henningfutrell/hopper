// The reap a job's machine runs when the job ends (issues #401, #410), run for real: a real shell, real
// processes carrying the job's HOPPER_JOB_ID, a real systemd user scope where there is one, real git
// repositories in the job's scratch dir. And the survey the sweep asks of a machine.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userSystemd } from '../support/systemd.ts';
import { REAP_DONE, readReap, readSurvey, reapArgv, scopeUnitOf, scriptArgvOf, surveyArgv } from '../../src/client/server.ts';

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

/** Run the reap as a machine's connection does. Called from a process that carries the job's id, it still never stops itself. */
function reap(jobId = JOB, dir = scratch, env: NodeJS.ProcessEnv = process.env): string {
  const [file, ...args] = reapArgv(jobId, dir);
  return execFileSync(file!, args, { encoding: 'utf8', env, timeout: 30000 });
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
  it.runIf(existsSync('/proc/self/environ'))('stops every process carrying the job\'s HOPPER_JOB_ID, never another job\'s, nor itself when run with that id', () => {
    const mine = [straggler(JOB), straggler(JOB)];
    const theirs = straggler(OTHER);
    const out = reap(JOB, scratch, { ...process.env, HOPPER_JOB_ID: JOB });
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

  it('reads nothing from a reap that did not finish', () => {
    expect(readReap('hopper-kept /w/.hopper-scratch/j/repo\n')).toBeUndefined();
  });

  it('with no scratch dir named, stops the job\'s processes and removes nothing', () => {
    writeFileSync(join(scratch, 'tmp.txt'), 'x');
    expect(readReap(reap(JOB, ''))).toEqual({ kept: [] });
    expect(existsSync(join(scratch, 'tmp.txt'))).toBe(true);
  });
});

describe('the reap stops the job\'s scope (issue #410)', () => {
  it.runIf(userSystemd)('a process that cleared its environment and left its session is stopped with the scope', () => {
    const unit = `${scopeUnitOf(JOB)}-${process.pid}`;
    const id = `${JOB}-${process.pid}`;
    const marker = `jh-410-escapee-${process.pid}`;
    // The scope's own shell starts the escapee: no HOPPER_JOB_ID, its own session, nothing tying it to the job but its cgroup.
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=10s', '--',
      'sh', '-c', `env -i setsid sh -c 'exec -a ${marker} sleep 300' </dev/null >/dev/null 2>&1 &`], { timeout: 10000 });
    const running = (): boolean => spawnSync('pgrep', ['-f', marker]).status === 0;
    expect(running()).toBe(true);
    expect(reap(id, '')).toContain(REAP_DONE);
    expect(running()).toBe(false);
  });
});

describe('a job worktree linked to shared dependencies (issue #410)', () => {
  it('its node_modules link is no work of the job\'s: the worktree is removed, never with --force, and the shared dependencies stay', () => {
    const main = join(root, 'main');
    cloneAt(main);
    const shared = join(root, 'work', '.hopper-scratch', 'deps', 'abc', 'node_modules');
    mkdirSync(join(shared, 'left-pad'), { recursive: true });
    writeFileSync(join(shared, 'left-pad', 'index.js'), '');
    const tree = join(scratch, 'wt');
    git(main, 'worktree', 'add', '-q', '--detach', tree, 'origin/main');
    symlinkSync(shared, join(tree, 'node_modules'));
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(shared, 'left-pad', 'index.js'))).toBe(true);
    expect(git(main, 'worktree', 'list')).not.toContain(tree);
  });

  it('keeps a worktree with other untracked files', () => {
    const main = join(root, 'main');
    cloneAt(main);
    const tree = join(scratch, 'wt');
    git(main, 'worktree', 'add', '-q', '--detach', tree, 'origin/main');
    mkdirSync(join(root, 'nm'));
    symlinkSync(join(root, 'nm'), join(tree, 'node_modules'));
    writeFileSync(join(tree, 'new.txt'), 'n\n');
    expect(readReap(reap())).toEqual({ kept: [tree] });
    expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true);
  });
});

describe('the survey a sweep asks of a machine (issue #410)', () => {
  function survey(...roots: string[]): string {
    const [file, ...args] = surveyArgv(roots);
    return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
  }

  it.runIf(existsSync('/proc/self/environ'))('names each job with a process carrying its id, once', () => {
    straggler(JOB);
    straggler(JOB);
    straggler(OTHER);
    const found = readSurvey(survey());
    expect(found?.processes).toEqual(expect.arrayContaining([JOB, OTHER]));
    expect(found?.processes.filter((p) => p === JOB)).toHaveLength(1);
  });

  it('lists each scratch dir under the work trees with its age, and nothing that is no directory', () => {
    const work = join(root, 'work');
    const old = join(work, '.hopper-scratch', OTHER);
    mkdirSync(old);
    const hour = Date.now() / 1000 - 3600;
    utimesSync(old, hour, hour);
    writeFileSync(join(work, '.hopper-scratch', '.gitignore'), '*\n');
    const found = readSurvey(survey(work, join(root, 'nowhere')));
    expect(found?.scratch.map((d) => d.path).sort()).toEqual([old, scratch].sort());
    const aged = found!.scratch.find((d) => d.path === old)!;
    expect(aged.jobId).toBe(OTHER);
    expect(aged.ageMs).toBeGreaterThanOrEqual(3590_000);
    expect(found!.scratch.find((d) => d.path === scratch)!.ageMs).toBeLessThan(60_000);
  });

  it.runIf(userSystemd)('names each job with a running scope', () => {
    const id = `${JOB}-s${process.pid}`;
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${scopeUnitOf(id)}`, '--',
      'sh', '-c', 'setsid sleep 300 </dev/null >/dev/null 2>&1 &'], { timeout: 10000 });
    try {
      expect(readSurvey(survey())?.scopes).toContain(id);
    } finally {
      reap(id, '');
    }
    expect(readSurvey(survey())?.scopes).not.toContain(id);
  });

  it('reads nothing from a survey that did not finish', () => {
    expect(readSurvey('hopper-proc a\n')).toBeUndefined();
  });
});

describe('what a client takes in a /reap or /survey body (issue #410)', () => {
  it('a job id and its own scratch dir, or work trees: nothing else reaches the script', () => {
    expect(scriptArgvOf('/reap', { jobId: JOB, scratch: `/w/.hopper-scratch/${JOB}` })).toEqual(reapArgv(JOB, `/w/.hopper-scratch/${JOB}`));
    expect(scriptArgvOf('/reap', { jobId: JOB })).toEqual(reapArgv(JOB));
    expect(scriptArgvOf('/reap', { jobId: '-rf' })).toBe('jobId must be a job id');
    expect(scriptArgvOf('/reap', { jobId: 'a*' })).toBe('jobId must be a job id');
    expect(scriptArgvOf('/reap', { jobId: JOB, scratch: '/home/me' })).toBe('scratch must be the job\'s own scratch dir');
    expect(scriptArgvOf('/reap', { jobId: JOB, scratch: `/w/.hopper-scratch/${OTHER}` })).toBe('scratch must be the job\'s own scratch dir');
    expect(scriptArgvOf('/survey', { roots: ['/w', '/x'] })).toEqual(surveyArgv(['/w', '/x']));
    expect(scriptArgvOf('/survey', { roots: ['relative'] })).toBe('roots must be at most 256 absolute paths');
    expect(scriptArgvOf('/survey', {})).toBe('roots must be at most 256 absolute paths');
  });
});
