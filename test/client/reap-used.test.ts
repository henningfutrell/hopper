// What the job's scope used (issue #2498): the reap reads the scope's cgroup before it stops it — its peak memory, its CPU
// time and the OOM kills in it —, and says it. Run for real with a stand-in systemctl and cgroup tree: a test machine may
// have no systemd user manager (a container, CI).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function reap(bin: string, cgroupRoot: string): string {
  const [file, ...args] = reapArgv(JOB, '');
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
