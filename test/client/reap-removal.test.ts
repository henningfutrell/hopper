// The reap of a scratch dir that a plain `rm -rf` cannot remove (issue #1452), run for real: a real shell, real dirs. The
// sweep found such a dir again on each pass, and the reap said each time that it removed it. Not as root: root removes
// what these tests make read-only.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';

const JOB = 'job-1452-abcdef';

let root: string;
let scratch: string;

const reap = (): string => {
  const [file, ...args] = reapArgv(JOB, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-'));
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  execFileSync('chmod', ['-R', 'u+rwX', root]);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.getuid?.() === 0)('a scratch dir that resists its removal (issue #1452)', () => {
  it('removes one that holds read-only directories, as a Go module cache does', () => {
    const mod = join(scratch, 'go', 'pkg', 'mod');
    mkdirSync(join(mod, 'x@v1'), { recursive: true });
    writeFileSync(join(mod, 'x@v1', 'x.go'), 'package x\n');
    chmodSync(join(mod, 'x@v1'), 0o555);
    chmodSync(mod, 0o555);
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
  });

  // A container's overlay storage in the scratch dir (issue #2490): the kernel leaves its `work/work` dir write-only
  // (mode 200), so a remove cannot list it, and a dir made writable only still cannot be read.
  it('removes one that holds a directory its owner cannot read, as an overlay work dir', () => {
    const work = join(scratch, 'containers', 'storage', 'overlay', 'abc', 'work');
    mkdirSync(join(work, 'work', 'inner'), { recursive: true });
    chmodSync(join(work, 'work'), 0o200);
    chmodSync(work, 0o000);
    expect(readReap(reap())).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
  });

  it('names what it could not remove, so nobody is told it is removed', () => {
    const area = join(root, 'work', '.worktrees', '@scratch');
    writeFileSync(join(scratch, 'tmp.txt'), 'x');
    chmodSync(area, 0o555);
    try {
      expect(readReap(reap())).toEqual({ kept: [], left: [scratch] });
      expect(existsSync(scratch)).toBe(true);
    } finally {
      chmodSync(area, 0o755);
    }
  });
});
