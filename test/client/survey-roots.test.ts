// The survey a sweep asks of a machine, run for real (issue #1120): it names each work tree whose scratch area is there,
// so the sweep knows a kept job's scratch dir missing from it is gone, and not only out of sight.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
