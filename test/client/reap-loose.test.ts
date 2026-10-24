// Issue #2715: the scratch area holds only job scratch dirs, each named by its job's id (a UUID). What else is there — a file
// a job wrote beside its own dir, a dir of no job — is removed by a reap in that work tree once nothing in it changed for a
// week, so nothing in the scratch area stays unjudged. A dir named as a job's is left to the sweep, which knows the jobs. Real
// shell, real dirs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOOSE_GRACE_DAYS, readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = '7d0c9b1e-2f4a-4c55-9e3b-1a2b3c4d5e6f';
const OTHER = '0d690911-6870-4b5f-8ae0-a5ac41788893';

let root: string, area: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-loose-'));
  area = join(root, 'work', '.worktrees', '@scratch');
  mkdirSync(join(area, JOB), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const old = (path: string): void => { const t = new Date(Date.now() - (LOOSE_GRACE_DAYS + 1) * 86_400_000); utimesSync(path, t, t); };
const reap = (keep = false) => {
  const [file, ...args] = reapArgv(JOB, join(area, JOB), keep);
  return readReap(execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 }));
};

describe('loose entries in the scratch area (issue #2715)', () => {
  it('removes a file and a dir of no job that did not change for a week, and names them', () => {
    writeFileSync(join(area, 'pr.md'), 'x'); old(join(area, 'pr.md'));
    mkdirSync(join(area, 'helm', 'charts'), { recursive: true });
    writeFileSync(join(area, 'helm', 'charts', 'a.yaml'), 'x');
    old(join(area, 'helm', 'charts', 'a.yaml')); old(join(area, 'helm', 'charts')); old(join(area, 'helm'));

    const said = reap();
    expect(existsSync(join(area, 'pr.md'))).toBe(false);
    expect(existsSync(join(area, 'helm'))).toBe(false);
    expect(said?.loose?.sort()).toEqual([join(area, 'helm'), join(area, 'pr.md')]);
  });

  it('keeps one changed in the week, a dir named as a job\'s, and all of them for a job kept', () => {
    writeFileSync(join(area, 'new.txt'), 'x');
    mkdirSync(join(area, 'notes'));
    writeFileSync(join(area, 'notes', 'today.txt'), 'x'); old(join(area, 'notes'));
    mkdirSync(join(area, OTHER)); old(join(area, OTHER));
    writeFileSync(join(area, 'old.txt'), 'x'); old(join(area, 'old.txt'));

    expect(reap(true)?.loose).toBeUndefined();
    expect(existsSync(join(area, 'old.txt'))).toBe(true);
    const said = reap();
    expect(said?.loose).toEqual([join(area, 'old.txt')]);
    for (const p of ['new.txt', 'notes', OTHER]) expect(existsSync(join(area, p)), p).toBe(true);
  });
});
