// What holds a machine's jobs' memory (issue #2622): each job's own scope, where a systemd user manager runs there (the
// scope gets its job limits); else a cgroup memory limit over the machine itself (a seat's container, a unit's MemoryMax);
// else nothing, and one burst of builds there can take the whole host. Each meter says which: this machine's and a
// client's (src/client/resources.ts), and an ssh target's probe (src/machines/resources.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceMeter } from '../../src/client/resources.ts';
import { readResources, resourcesOf } from '../../src/machines/resources.ts';

const KIB = 1024;
const GIB = 1024 ** 3;
const USER = 'sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-lim-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (platform = 'linux') => createResourceMeter({
  root, platform, now: () => 1_000_000, env: {}, uid: 1000, cpus: () => [], parallelism: () => 2, loadavg: () => [0, 0, 0], totalmem: () => 16 * GIB, freemem: () => 4 * GIB,
})();

describe('this machine\'s meter', () => {
  beforeEach(() => put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`));

  it('scope: its user has a systemd user manager', () => {
    put(`${USER}/memory.current`, `${GIB}\n`);
    expect(read().jobMemoryLimit).toBe('scope');
  });

  it('machine: no user manager, but a memory limit on its own cgroup', () => {
    put('proc/self/cgroup', '0::/machine.slice/seat.scope\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.current', `${GIB}\n`);
    expect(read().jobMemoryLimit).toBe('machine');
  });

  it('none: neither', () => {
    put('proc/self/cgroup', '0::/machine.slice/seat.scope\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.max', 'max\n');
    expect(read().jobMemoryLimit).toBe('none');
  });

  it('not said off Linux', () => {
    expect(read('darwin')).not.toHaveProperty('jobMemoryLimit');
  });
});

describe('an ssh target\'s probe', () => {
  const printed = (...more: string[]): string => [
    `hopper-res MemTotal:       ${16 * GIB / KIB} kB`,
    `hopper-res MemAvailable:   ${10 * GIB / KIB} kB`,
    ...more.map((l) => `hopper-res ${l}`),
    'hopper-res 8',
  ].join('\n');

  it('scope when it printed its user manager, machine under a cgroup limit, else none', () => {
    expect(readResources(printed('um'))?.jobMemoryLimit).toBe('scope');
    expect(readResources(printed(`cg /seat ${4 * GIB} ${GIB} 0`))?.jobMemoryLimit).toBe('machine');
    expect(readResources(printed())?.jobMemoryLimit).toBe('none');
  });
});

describe('a client\'s answer', () => {
  it('keeps a known value and drops any other', () => {
    const base = { cores: 2, memTotalBytes: 8 * GIB, memAvailableBytes: 4 * GIB };
    expect(resourcesOf({ ...base, jobMemoryLimit: 'none' })?.jobMemoryLimit).toBe('none');
    expect(resourcesOf({ ...base, jobMemoryLimit: 'lots' })).not.toHaveProperty('jobMemoryLimit');
  });
});
