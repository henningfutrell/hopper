// What each job takes on a machine (issue #2494): the survey measures each job's scratch dir and each job worktree on its
// own, run for real, so Machines can name the jobs that take the most.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSurvey, surveyArgv } from '../../src/client/reap.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hopper-job-disk-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function survey(...roots: string[]): string {
  const [file, ...args] = surveyArgv(roots);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
}

function fill(dir: string, kib: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'big'), Buffer.alloc(kib * 1024, 1));
}

describe('the bytes of each job a survey measured (issue #2494)', () => {
  it('measures each scratch dir and each job worktree on its own, with its job and kind', () => {
    const work = join(root, 'work');
    fill(join(work, '.worktrees', '@scratch', 'job-1'), 256);
    fill(join(work, '.worktrees', 'app', 'job-1'), 512);
    fill(join(work, '.worktrees', 'app', 'job-2'), 128);
    const jobs = readSurvey(survey(work))?.jobs ?? [];
    expect(jobs.map((j) => [j.jobId, j.kind, j.path]).sort()).toEqual([
      ['job-1', 'scratch', join(work, '.worktrees', '@scratch', 'job-1')],
      ['job-1', 'tree', join(work, '.worktrees', 'app', 'job-1')],
      ['job-2', 'tree', join(work, '.worktrees', 'app', 'job-2')],
    ]);
    const bytes = (jobId: string, kind: string): number => jobs.find((j) => j.jobId === jobId && j.kind === kind)!.bytes;
    expect(bytes('job-1', 'scratch')).toBeGreaterThanOrEqual(256 * 1024);
    expect(bytes('job-1', 'tree')).toBeGreaterThanOrEqual(512 * 1024);
    expect(bytes('job-2', 'tree')).toBeGreaterThanOrEqual(128 * 1024);
  });

  it('measures no dir that is not a job\'s, nor a link', () => {
    const work = join(root, 'work');
    fill(join(work, '.worktrees', '@deps', 'abc'), 64);
    fill(join(work, '.worktrees', 'app', 'not a job'), 64);
    fill(join(root, 'elsewhere'), 64);
    mkdirSync(join(work, '.worktrees', '@scratch'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(work, '.worktrees', '@scratch', 'job-3'));
    expect(readSurvey(survey(work))?.jobs ?? []).toEqual([]);
  });
});
