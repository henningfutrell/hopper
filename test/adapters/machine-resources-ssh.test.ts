// An ssh target's job scopes, CPU throttle and OOM kills (issue #2499 part 13): the lines RESOURCES_COMMAND prints for them,
// and the last OOM kill an attached machine keeps from one probe to the next. The probe itself runs in a shell here too.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_PROCESSES_COMMAND, RESOURCES_COMMAND, readOomKills, readResources } from '../../src/machines/resources.ts';
import { createAttachedMachineSource, type MachineProbe } from '../../src/machines/index.ts';

const KIB = 1024;
const GIB = 1024 ** 3;
const MANAGER = '/user.slice/user-1000.slice/user@1000.service';

const printed = (...more: string[]): string => [
  'hopper-res cpu  100 0 100 700 100 0 0 0 0 0',
  'hopper-res cpu  300 0 200 1100 200 0 0 0 0 0',
  `hopper-res MemTotal:       ${16 * GIB / KIB} kB`,
  `hopper-res MemAvailable:   ${10 * GIB / KIB} kB`,
  ...more.map((l) => `hopper-res ${l}`),
  'hopper-res 8',
].join('\n');

describe('an ssh target\'s CPU throttle (issue #2499 part 13)', () => {
  it('the share of periods throttled in the probe\'s second, the most of its cgroups with a quota', () => {
    const r = readResources(printed('ct0 /seat 1000 100', 'ct0 /seat/a 500 0', 'ct1 /seat 1010 108', 'ct1 /seat/a 510 1'));
    expect(r?.cpuThrottledFrac).toBe(0.8);
  });

  it('none with no quota, a cgroup read once, or periods that did not move', () => {
    expect(readResources(printed())).not.toHaveProperty('cpuThrottledFrac');
    expect(readResources(printed('ct0 /seat 1000 100'))).not.toHaveProperty('cpuThrottledFrac');
    expect(readResources(printed('ct0 /seat 1000 100', 'ct1 /seat 1000 100'))).not.toHaveProperty('cpuThrottledFrac');
    expect(readResources(printed('ct0 /seat 1000 100', 'ct1 /seat 1010 90'))).not.toHaveProperty('cpuThrottledFrac');
  });
});

describe('an ssh target\'s job scopes (issue #2499 part 13)', () => {
  const scope = (id: string, slice = 'app.slice') => `${MANAGER}/${slice}/hopper-job-${id}.scope`;

  it('each scope\'s memory in use less its page cache, and what it used so far', () => {
    const r = readResources(printed(
      `cgj ${scope('j1')} cur=${3 * GIB} i=${GIB} peak=${4 * GIB} usec=5000000 oom=1`,
      `cgj ${scope('j2', 'session.slice')} cur=${GIB}`,
    ));
    expect(r?.jobMemoryBytes).toEqual({ j1: 2 * GIB, j2: GIB });
    expect(r?.jobUse).toEqual({ j1: { memoryPeakBytes: 4 * GIB, cpuSeconds: 5, oomKills: 1 } });
  });

  it('a scope outside the cgroup whose limit it reads takes that memory off its memory available', () => {
    const r = readResources(printed(`cg /seat ${4 * GIB} ${GIB}`, `cgj ${scope('out')} cur=${GIB / 2}`, `cgj /seat/hopper-job-in.scope cur=${GIB}`));
    expect(r).toMatchObject({ memTotalBytes: 4 * GIB, memAvailableBytes: 2.5 * GIB, jobMemoryBytes: { out: GIB / 2, in: GIB } });
  });

  it('a line not whole, or a name that is no job scope, is none', () => {
    const r = readResources(printed(`cgj ${scope('j1')} i=${GIB}`, `cgj ${MANAGER}/app.slice/other.scope cur=1`, `cgj ${scope('a b')} cur=1`));
    expect(r).not.toHaveProperty('jobMemoryBytes');
    expect(r).not.toHaveProperty('jobUse');
  });
});

describe('an ssh target\'s OOM kill count (issue #2499 part 13)', () => {
  it('of the cgroup whose limit it reads, else the kernel\'s', () => {
    expect(readOomKills(printed(`cg /seat ${4 * GIB} ${GIB}`, 'cgo /seat 3', 'cgo /other 9', 'oom 12'))).toEqual({ of: '/seat', count: 3 });
    expect(readOomKills(printed('cgo /other 9', 'oom 12'))).toEqual({ of: 'kernel', count: 12 });
    expect(readOomKills(printed())).toBeUndefined();
  });

  it('an attached machine sees a kill when the count grew since its probe before; the first probe sees none', async () => {
    let t = Date.parse('2026-10-23T10:00:00.000Z');
    let answer: MachineProbe = { online: true, resources: { cores: 1, memTotalBytes: GIB, memAvailableBytes: GIB }, oomKills: { of: '/seat', count: 2 } };
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'seat', ssh: 'seat', lanes: 1, executors: [], herdr: false, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    const after = async () => { await src.list(); await new Promise((r) => setTimeout(r, 0)); return (await src.list())[0]!.resources; };
    expect(await after()).not.toHaveProperty('memOomKillAt');
    t += 30000;
    expect(await after()).not.toHaveProperty('memOomKillAt');
    t += 30000;
    const killed = new Date(t).toISOString();
    answer = { ...answer, oomKills: { of: '/seat', count: 3 } };
    expect(await after()).toMatchObject({ memOomKillAt: killed });
    // Kept on later probes; a count of another cgroup is no kill.
    t += 30000;
    answer = { ...answer, oomKills: { of: 'kernel', count: 50 } };
    expect(await after()).toMatchObject({ memOomKillAt: killed });
  });
});

describe('the probe in a shell (issue #2499 part 13)', () => {
  it('runs in dash with its new lines, and reads as resources', () => {
    const out = execFileSync('sh', ['-c', RESOURCES_COMMAND], { encoding: 'utf8' });
    expect(out.split('\n').filter((l) => l && !l.startsWith('hopper-res '))).toEqual([]);
    expect(readResources(out)).toMatchObject({ cores: expect.any(Number) });
    if (/^0::/m.test(execFileSync('cat', ['/proc/self/cgroup'], { encoding: 'utf8' }))) expect(readOomKills(out)).toBeDefined();
  });
});

describe('an ssh target\'s job processes with no user manager (issue #2737)', () => {
  it('each job\'s processes, by HOPPER_JOB_ID and by parent, with their own memory', () => {
    const r = readResources(printed('jp 1 0 1000', 'jp 100 1 102400', 'je 100 j1', 'jp 101 100 307200', 'jp 200 1 51200 j2', 'jp 300 1 999', 'jp x 1 5', 'je 101 a b'));
    expect(r).toMatchObject({ jobMemoryBytes: { j1: 400 * 1024 ** 2, j2: 50 * 1024 ** 2 }, jobMemoryLimit: 'none' });
  });

  it('none where its user manager runs: the scopes say it', () => {
    expect(readResources(printed('um', 'jp 100 1 102400', 'je 100 j1'))).not.toHaveProperty('jobMemoryBytes');
  });

  it('the process lines in a shell: the shell that has HOPPER_JOB_ID, and what it started', () => {
    const out = execFileSync('sh', ['-c', `{ ${JOB_PROCESSES_COMMAND}; } | sed 's/^/hopper-res /'; echo 'hopper-res MemTotal: 16777216 kB'; echo 'hopper-res MemAvailable: 8388608 kB'; echo 'hopper-res 4'`], { encoding: 'utf8', env: { ...process.env, HOPPER_JOB_ID: 'jt' } });
    expect(readResources(out)?.jobMemoryBytes?.jt).toBeGreaterThan(0);
  });

  it('on macOS (no /proc): memory, load and cores from sysctl and vm_stat, and the job processes from ps', () => {
    const bin = mkdtempSync(join(tmpdir(), 'jh-mac-'));
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    try {
      fake('uname', 'echo Darwin');
      fake('sysctl', 'case "$2" in hw.memsize) echo 17179869184;; hw.ncpu) echo 8;; vm.loadavg) echo "{ 1.50 1.25 1.00 }";; esac');
      fake('vm_stat', [
        'cat <<X', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)', 'Pages free:                               65536.',
        'Pages active:                            300000.', 'Pages inactive:                          131072.', 'Pages speculative:                        65536.', 'X',
      ].join('\n'));
      fake('ps', ['cat <<X', '    1     0  10240 /sbin/launchd', '  100     1 102400 node run.js HOPPER_JOB_ID=j1 HOME=/x', '  101   100 307200 node worker.js', 'X'].join('\n'));
      const out = execFileSync('/bin/sh', ['-c', RESOURCES_COMMAND], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      expect(out.split('\n').filter((l) => l && !l.startsWith('hopper-res '))).toEqual([]);
      expect(readResources(out)).toEqual({
        cores: 8, load: [1.5, 1.25, 1], memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB,
        jobMemoryBytes: { j1: 400 * 1024 ** 2 }, jobMemoryLimit: 'none',
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
