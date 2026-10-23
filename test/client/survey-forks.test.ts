// Issue #2490: the sweep's survey of a native Windows client timed out after 60 s, so nothing was reaped there. The sh
// of Git for Windows (MSYS) starts a program slowly, and the survey started `stat` once for each scratch dir and job
// worktree, and `tr` and `sed` once for each process: about 520 dirs took longer than the timeout. Now the programs it
// starts do not grow with what it finds.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSurvey, surveyArgv } from '../../src/client/reap.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hopper-survey-forks-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A dir of shims on PATH that count each start of the named programs, then run the real one. */
function counted(...programs: string[]): { path: string; starts: (program: string) => number } {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const p of programs) {
    const real = execFileSync('sh', ['-c', `command -v ${p}`], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, p), `#!/bin/sh\necho x >> '${join(root, `${p}.starts`)}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, p), 0o755);
  }
  const starts = (p: string): number => { try { return readFileSync(join(root, `${p}.starts`), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  return { path: `${bin}:${process.env.PATH ?? ''}`, starts };
}

describe('the programs a survey starts (issue #2490)', () => {
  it('starts stat and tr a few times only, however many scratch dirs, job worktrees and processes it finds; the ages stay right', () => {
    const work = join(root, 'work');
    const dirs: string[] = [];
    for (let i = 0; i < 30; i++) {
      for (const d of [join(work, '.worktrees', '@scratch', `job-${i}`), join(work, '.hopper-scratch', `old-${i}`), join(work, '.worktrees', 'app', `job-${i}`)]) {
        mkdirSync(d, { recursive: true });
        dirs.push(d);
      }
    }
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(join(work, '.worktrees', '@scratch', 'job-0'), hourAgo, hourAgo);
    const shims = counted('stat', 'tr');
    const [file, ...args] = surveyArgv([work]);
    const found = readSurvey(execFileSync(file!, args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: shims.path } }));
    expect(found?.scratch).toHaveLength(60);
    expect(found?.trees).toHaveLength(30);
    expect(found?.scratch.find((d) => d.jobId === 'job-0')?.ageMs).toBeGreaterThanOrEqual(3590_000);
    expect(found?.scratch.find((d) => d.jobId === 'job-1')?.ageMs).toBeLessThan(60_000);
    expect(shims.starts('stat')).toBeLessThanOrEqual(3);
    expect(shims.starts('tr')).toBeLessThanOrEqual(1);
  });

  it('names a dir whose path holds a space, with its age', () => {
    const work = join(root, 'my work');
    mkdirSync(join(work, '.worktrees', '@scratch', 'job-1'), { recursive: true });
    mkdirSync(join(work, '.worktrees', 'my app', 'job-1'), { recursive: true });
    const [file, ...args] = surveyArgv([work]);
    const found = readSurvey(execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 }));
    expect(found?.scratch.map((d) => d.path)).toEqual([join(work, '.worktrees', '@scratch', 'job-1')]);
    expect(found?.trees?.map((t) => t.path)).toEqual([join(work, '.worktrees', 'my app', 'job-1')]);
    expect(found?.scratch[0]!.ageMs).toBeLessThan(60_000);
  });
});
