// The survey a sweep asks of a machine, run for real (issue #1120): it names each work tree whose `.worktrees` is there,
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
  it('names each work tree whose .worktrees is there, or the layout before\'s scratch area; not one without it, nor one that is not there', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.worktrees', '@scratch'), { recursive: true });
    const old = join(root, 'old');
    mkdirSync(join(old, '.hopper-scratch'), { recursive: true });
    const bare = join(root, 'bare');
    mkdirSync(bare);
    expect(readSurvey(survey(work, old, bare, join(root, 'nowhere')))?.roots).toEqual([work, old]);
  });

  it('names none when it asked about none', () => {
    expect(readSurvey(survey())?.roots).toEqual([]);
  });
});

describe('the hopper\'s own disk use a survey measured (issue #1120)', () => {
  it('measures each named work tree\'s .worktrees, its scratch dirs and job worktrees, in bytes; not a work tree it does not name', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.worktrees', '@scratch', 'job-1'), { recursive: true });
    writeFileSync(join(work, '.worktrees', '@scratch', 'job-1', 'big'), Buffer.alloc(256 * 1024, 1));
    mkdirSync(join(work, '.worktrees', 'app', 'job-1'), { recursive: true });
    writeFileSync(join(work, '.worktrees', 'app', 'job-1', 'big'), Buffer.alloc(512 * 1024, 1));
    const bare = join(root, 'bare');
    mkdirSync(join(bare, '.worktrees', 'app'), { recursive: true });
    const usage = readSurvey(survey(work))?.usage ?? [];
    expect(usage.map((u) => u.path)).toEqual([join(work, '.worktrees')]);
    expect(usage[0]!.bytes).toBeGreaterThanOrEqual(768 * 1024);
    expect(usage[0]!.bytes % 1024).toBe(0);
  });

  it('measures what the layout before issue #1188 left, while it is there', () => {
    const work = join(root, 'work');
    mkdirSync(join(work, '.hopper-scratch', 'job-1'), { recursive: true });
    mkdirSync(join(work, 'workspace', 'worktrees', 'app-job-1'), { recursive: true });
    expect(readSurvey(survey(work))?.usage?.map((u) => u.path)).toEqual([join(work, '.hopper-scratch'), join(work, 'workspace', 'worktrees')]);
  });
});

describe('what the layout before issue #1188 left, which the sweep removes', () => {
  it('lists its scratch dirs and its job worktrees with the new ones', () => {
    const work = join(root, 'work');
    const old = join(work, '.hopper-scratch', 'job-1');
    const oldTree = join(work, 'workspace', 'worktrees', 'app-job-1');
    const now = join(work, '.worktrees', '@scratch', 'job-2');
    const tree = join(work, '.worktrees', 'app', 'job-2');
    for (const d of [old, oldTree, now, tree, join(work, '.worktrees', '@deps', 'abc')]) mkdirSync(d, { recursive: true });
    const found = readSurvey(survey(work));
    expect(found?.scratch.map((d) => [d.jobId, d.path])).toEqual([['job-2', now], ['job-1', old]]);
    expect(found?.trees?.map((t) => t.path)).toEqual([tree, oldTree]);
  });
});
