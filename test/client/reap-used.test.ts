// What the job's scope used (issue #2498): the reap reads the scope's cgroup before it stops it — its peak memory, its CPU
// time and the OOM kills in it —, and says it. Run for real with a stand-in systemctl and cgroup tree: a test machine may
// have no systemd user manager (a container, CI). Part 4: the disk its scratch dir and worktrees hold, read before they go.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv, scopeUnitOf } from '../../src/client/reap.ts';

const JOB = 'job-2498-abcdef';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reap-used-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A systemctl that names `cgroup` as the scope's ControlGroup (empty: no such unit), and stops nothing. */
function systemctl(cgroup: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ncase "$*" in *ControlGroup*) printf '%s\\n' '${cgroup}';; esac\nexit 0\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  return bin;
}

/** The scope's cgroup dir under the stand-in cgroup root, with the files given. */
function cgroupDir(path: string, files: Record<string, string>): string {
  const top = join(root, 'cgroup');
  mkdirSync(join(top, path), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(top, path, name), text);
  return top;
}

function reap(bin: string, cgroupRoot: string, scratch = ''): string {
  const [file, ...args] = reapArgv(JOB, scratch);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOPPER_CGROUP_ROOT: cgroupRoot } });
}

const SCOPE = `/user.slice/user-1000.slice/user@1000.service/app.slice/${scopeUnitOf(JOB)}.scope`;

describe('the reap says what the job\'s scope used (issue #2498)', () => {
  it('its peak memory, its CPU time and the OOM kills in it, read before the scope is stopped', () => {
    const top = cgroupDir(SCOPE, {
      'memory.peak': '3221225472\n',
      'cpu.stat': 'usage_usec 754500000\nuser_usec 700000000\nsystem_usec 54500000\n',
      'memory.events': 'low 0\nhigh 0\nmax 12\noom 2\noom_kill 1\noom_group_kill 0\n',
    });
    expect(readReap(reap(systemctl(SCOPE), top))?.used).toEqual({ memoryPeakBytes: 3221225472, cpuSeconds: 754.5, oomKills: 1 });
  });

  it('only what the cgroup has: a kernel with no memory.peak gives no peak', () => {
    const top = cgroupDir(SCOPE, { 'cpu.stat': 'usage_usec 2000000\n', 'memory.events': 'oom_kill 0\n' });
    expect(readReap(reap(systemctl(SCOPE), top))?.used).toEqual({ cpuSeconds: 2, oomKills: 0 });
  });

  it('nothing when the job has no scope, or its cgroup is gone', () => {
    const top = cgroupDir('/other.scope', { 'memory.peak': '1\n' });
    expect(readReap(reap(systemctl(''), top))?.used).toBeUndefined();
    expect(readReap(reap(systemctl(SCOPE), top))?.used).toBeUndefined();
  });

  it('never a cgroup path that leaves the cgroup root', () => {
    const top = cgroupDir('/x', {});
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'memory.peak'), '7\n');
    expect(readReap(reap(systemctl('/../outside'), top))?.used).toBeUndefined();
  });
});

describe('the reap says the disk the job used (issue #2498 part 4)', () => {
  const MIB = 1024 ** 2;
  /** A work tree with the job's scratch dir and one worktree, each with a file of `mib` MiB that does not compress. */
  function workTree(mib: { scratch: number; tree: number }): { scratch: string; tree: string } {
    const w = join(root, 'w');
    const scratch = join(w, '.worktrees', '@scratch', JOB), tree = join(w, '.worktrees', 'repo', JOB);
    mkdirSync(scratch, { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(scratch, 'build.out'), randomBytes(mib.scratch * MIB));
    writeFileSync(join(tree, 'src.bin'), randomBytes(mib.tree * MIB));
    return { scratch, tree };
  }

  it('what its scratch dir and worktrees held, with no cgroup, read before the reap removes them', () => {
    const { scratch } = workTree({ scratch: 3, tree: 2 });
    const disk = readReap(reap(systemctl(''), cgroupDir('/x', {}), scratch))?.used?.diskBytes;
    // du counts blocks: each dir's own block is in it too (ext4: 4 KiB a dir).
    expect(disk).toBeGreaterThanOrEqual(5 * MIB);
    expect(disk).toBeLessThan(5 * MIB + 256 * 1024);
  });

  it('beside the scope\'s use, and never what a link in it points at (the shared node_modules)', () => {
    const { scratch, tree } = workTree({ scratch: 1, tree: 1 });
    const shared = join(root, 'shared');
    mkdirSync(shared);
    writeFileSync(join(shared, 'big.bin'), randomBytes(8 * MIB));
    symlinkSync(shared, join(tree, 'node_modules'));
    const top = cgroupDir(SCOPE, { 'memory.peak': '1024\n' });
    const used = readReap(reap(systemctl(SCOPE), top, scratch))?.used;
    expect(used).toMatchObject({ memoryPeakBytes: 1024 });
    expect(used?.diskBytes).toBeLessThan(2 * MIB + 256 * 1024);
  });
});
