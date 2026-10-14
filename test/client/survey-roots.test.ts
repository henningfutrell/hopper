// The survey a sweep asks of a machine, run for real (issue #1120): it names each work tree whose scratch area is there,
// so the sweep knows a kept job's scratch dir missing from it is gone, and not only out of sight.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSurvey, surveyArgv } from '../../src/client/reap.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hopper-survey-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function survey(...roots: string[]): string {
  const [file, ...args] = surveyArgv(roots);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
}

describe('the work trees a survey found (issue #1120)', () => {
  it('names each work tree whose scratch area is there; not one without it, nor one that is not there', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.hopper-scratch'), { recursive: true });
    const bare = join(root, 'bare');
    mkdirSync(bare);
    expect(readSurvey(survey(work, bare, join(root, 'nowhere')))?.roots).toEqual([work]);
  });

  it('names none when it asked about none', () => {
    expect(readSurvey(survey())?.roots).toEqual([]);
  });
});

describe('the hopper\'s own disk use a survey measured (issue #1120)', () => {
  it('measures each named work tree\'s scratch area and job worktrees, in bytes; not a work tree it does not name', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.hopper-scratch', 'job-1'), { recursive: true });
    writeFileSync(join(work, '.hopper-scratch', 'job-1', 'big'), Buffer.alloc(256 * 1024, 1));
    mkdirSync(join(work, 'workspace', 'worktrees', 'app-job-1'), { recursive: true });
    writeFileSync(join(work, 'workspace', 'worktrees', 'app-job-1', 'big'), Buffer.alloc(512 * 1024, 1));
    const bare = join(root, 'bare');
    mkdirSync(join(bare, 'workspace', 'worktrees'), { recursive: true });
    const usage = readSurvey(survey(work, bare))?.usage ?? [];
    expect(usage.map((u) => u.path)).toEqual([join(work, '.hopper-scratch'), join(work, 'workspace', 'worktrees')]);
    expect(usage[0]!.bytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(usage[1]!.bytes).toBeGreaterThanOrEqual(512 * 1024);
    expect(usage[1]!.bytes % 1024).toBe(0);
  });

  it('a work tree with no job worktrees: only its scratch area', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.hopper-scratch'), { recursive: true });
    expect(readSurvey(survey(work))?.usage?.map((u) => u.path)).toEqual([join(work, '.hopper-scratch')]);
  });
});
