// A job's processes without a systemd scope (issue #2737): where the machine runs no systemd user manager (WSL without
// systemd), the meter finds each job's processes by HOPPER_JOB_ID in their environment, and the processes they started
// by their parent, whatever these did to their environment; a job's memory is its processes' own memory (RssAnon and
// RssShmem), and its peak the most the meter saw. Read from a fake /proc here, so the test does not depend on the host.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobProcessMemory } from '../../src/client/job-processes.ts';
import { createResourceMeter } from '../../src/client/resources.ts';

const KIB = 1024;
const MIB = 1024 ** 2;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-procs-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A process in the fake /proc: its parent, its environment and its memory in MiB. */
function proc(pid: number, ppid: number, env: Record<string, string>, anonMib: number, shmemMib = 0): void {
  const dir = join(root, 'proc', String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (a (b) c) S ${ppid} ${pid} ${pid} 0 -1\n`);
  writeFileSync(join(dir, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''));
  writeFileSync(join(dir, 'status'), `Name:\tx\nVmRSS:\t${(anonMib + shmemMib + 5) * KIB} kB\nRssAnon:\t${anonMib * KIB} kB\nRssFile:\t${5 * KIB} kB\nRssShmem:\t${shmemMib * KIB} kB\n`);
}

describe('a job\'s processes without a scope', () => {
  it('sums each job\'s processes by HOPPER_JOB_ID, and the processes they started by their parent', () => {
    proc(1, 0, {}, 10);
    proc(100, 1, { HOPPER_JOB_ID: 'j1', PATH: '/bin' }, 100, 20);
    proc(101, 100, {}, 300);
    proc(102, 101, { HOME: '/x' }, 50);
    proc(200, 1, { HOPPER_JOB_ID: 'j2' }, 40);
    proc(201, 100, { HOPPER_JOB_ID: 'j2' }, 60);
    proc(300, 1, {}, 999);
    expect(jobProcessMemory(root)).toEqual(new Map([['j1', 470 * MIB], ['j2', 100 * MIB]]));
  });

  it('a process gone between the list and its read, or one it cannot read, is left out', () => {
    proc(100, 1, { HOPPER_JOB_ID: 'j1' }, 100);
    mkdirSync(join(root, 'proc', '101'));
    proc(102, 101, {}, 30);
    mkdirSync(join(root, 'proc', 'self'), { recursive: true });
    expect(jobProcessMemory(root)).toEqual(new Map([['j1', 100 * MIB]]));
  });

  it('no /proc: no jobs', () => {
    expect(jobProcessMemory(root).size).toBe(0);
  });

  it('the meter reads them only where no systemd user manager runs, and keeps each job\'s peak while it runs', () => {
    mkdirSync(join(root, 'proc'), { recursive: true });
    writeFileSync(join(root, 'proc', 'meminfo'), 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
    let t = 1_000_000;
    const read = createResourceMeter({ root, platform: 'linux', now: () => t, env: {}, uid: 1000, cpus: () => [], parallelism: () => 2, loadavg: () => [0, 0, 0] });
    proc(100, 1, { HOPPER_JOB_ID: 'j1' }, 300);
    expect(read()).toMatchObject({ jobMemoryBytes: { j1: 300 * MIB }, jobUse: { j1: { memoryPeakBytes: 300 * MIB } }, jobMemoryLimit: 'none' });
    proc(100, 1, { HOPPER_JOB_ID: 'j1' }, 100);
    t += 30_000;
    expect(read()).toMatchObject({ jobMemoryBytes: { j1: 100 * MIB }, jobUse: { j1: { memoryPeakBytes: 300 * MIB } } });
    rmSync(join(root, 'proc', '100'), { recursive: true });
    t += 30_000;
    expect(read()).not.toHaveProperty('jobMemoryBytes');
    proc(100, 1, { HOPPER_JOB_ID: 'j1' }, 50);
    t += 30_000;
    expect(read()).toMatchObject({ jobUse: { j1: { memoryPeakBytes: 50 * MIB } } });
    mkdirSync(join(root, 'sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service'), { recursive: true });
    t += 30_000;
    expect(read()).not.toHaveProperty('jobMemoryBytes');
  });
});
