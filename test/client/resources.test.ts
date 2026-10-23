// A machine's resources (issue #560): CPU, memory and swap as the machine's own meter reads them — this machine,
// and a client target's client in its `/release` answer. CPU busy is the share of CPU time busy between two
// reads; memory is what is available, not what is free; a machine in a container with cgroup limits reads its
// limits and its own use, not the host's. Read from a fake root here, so the test does not depend on the host.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceMeter, readWindowsMemory, type CpuTimes, type HostMemoryReader } from '../../src/client/resources.ts';

const KIB = 1024;
const GIB = 1024 ** 3;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-res-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const cpu = (busy: number, idle: number): CpuTimes => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });

/** A meter over a fake root and fake os readings: the clock and the CPU times move as the test says. */
function meter(o: { platform?: string; cpus?: () => CpuTimes[]; hostMemory?: HostMemoryReader; env?: Record<string, string>; node?: string; uid?: number } = {}) {
  let t = 1_000_000;
  let times = [cpu(0, 0), cpu(0, 0)];
  const read = createResourceMeter({
    root, platform: o.platform ?? 'linux', now: () => t, env: o.env ?? {}, ...(o.hostMemory ? { hostMemory: o.hostMemory } : {}), ...(o.node ? { node: o.node } : {}), ...(o.uid !== undefined ? { uid: o.uid } : {}),
    cpus: o.cpus ?? (() => times), parallelism: () => 2, loadavg: () => [0.5, 0.75, 1], totalmem: () => 16 * GIB, freemem: () => 4 * GIB,
  });
  return { read, advance(ms: number, next: CpuTimes[]) { t += ms; times = next; } };
}

describe('a machine\'s resources', () => {
  it('CPU busy is the share of CPU time busy since the read before; the first read has none', () => {
    const m = meter();
    const first = m.read();
    expect(first.cores).toBe(2);
    expect(first).not.toHaveProperty('cpuBusyFrac');
    m.advance(30_000, [cpu(300, 700), cpu(100, 900)]);
    expect(m.read().cpuBusyFrac).toBeCloseTo(0.2);
    m.advance(30_000, [cpu(1300, 700), cpu(1100, 900)]);
    expect(m.read().cpuBusyFrac).toBeCloseTo(1);
  });

  it('a read sooner than a second after the last keeps the last CPU busy: a burst of reads is not noise', () => {
    const m = meter();
    m.read();
    m.advance(30_000, [cpu(500, 500), cpu(500, 500)]);
    expect(m.read().cpuBusyFrac).toBeCloseTo(0.5);
    m.advance(100, [cpu(500, 501), cpu(500, 501)]);
    expect(m.read().cpuBusyFrac).toBeCloseTo(0.5);
  });

  it('on Linux, memory and swap from /proc/meminfo: available, not free', () => {
    put('proc/meminfo', [
      `MemTotal:       ${16 * GIB / KIB} kB`, `MemFree:         ${1 * GIB / KIB} kB`, `MemAvailable:    ${10 * GIB / KIB} kB`,
      `SwapTotal:       ${8 * GIB / KIB} kB`, `SwapFree:        ${6 * GIB / KIB} kB`,
    ].join('\n'));
    const r = meter().read();
    expect(r).toMatchObject({ memTotalBytes: 16 * GIB, memAvailableBytes: 10 * GIB, swapTotalBytes: 8 * GIB, swapUsedBytes: 2 * GIB, load: [0.5, 0.75, 1] });
    expect(r).not.toHaveProperty('container');
  });

  it('says the Node version it runs, and the patched floor it is below (issue #2479)', () => {
    expect(meter({ node: 'v26.12.1' }).read()).toMatchObject({ node: 'v26.12.1' });
    expect(meter({ node: 'v26.12.1' }).read()).not.toHaveProperty('nodeFloor');
    expect(meter({ node: 'v26.8.2' }).read()).toMatchObject({ node: 'v26.8.2', nodeFloor: '26.12.1' });
    expect(meter().read().node).toBe(process.version);
  });

  it('elsewhere (Windows, macOS), memory from the OS, no swap; no load on Windows, which has none', () => {
    const win = meter({ platform: 'win32' }).read();
    expect(win).toMatchObject({ cores: 2, memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB });
    expect(win).not.toHaveProperty('load');
    expect(win).not.toHaveProperty('swapTotalBytes');
    expect(meter({ platform: 'darwin' }).read().load).toEqual([0.5, 0.75, 1]);
  });

  it('in a container with cgroup limits: its memory limit and use, its CPU quota as cores, its own CPU time', () => {
    put('proc/meminfo', `MemTotal: ${64 * GIB / KIB} kB\nMemAvailable: ${60 * GIB / KIB} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB`);
    put('sys/fs/cgroup/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/memory.current', `${3 * GIB}\n`);
    put('sys/fs/cgroup/memory.stat', `anon 1\ninactive_file ${1 * GIB}\nactive_file 5\n`);
    put('sys/fs/cgroup/cpu.max', '150000 100000\n');
    put('sys/fs/cgroup/cpu.stat', 'usage_usec 0\nuser_usec 0\n');
    const m = meter();
    const first = m.read();
    expect(first).toMatchObject({ container: true, cores: 1.5, memTotalBytes: 4 * GIB, memAvailableBytes: 2 * GIB });
    // 30 s of wall time at 1.5 cores is 45 s of CPU: 9 s used is a fifth.
    put('sys/fs/cgroup/cpu.stat', `usage_usec ${9_000_000}\nuser_usec 0\n`);
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().cpuBusyFrac).toBeCloseTo(0.2);
  });

  // Issue #2499: a seat's container (cgroupns host) or a systemd unit's MemoryMax sets the limit on the process's own
  // cgroup or one above it, never on the root: the seat read the VM's total, not its 4 GiB.
  it('a limit on its own cgroup or one above it, as /proc/self/cgroup names it: the tightest, with its use', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/self/cgroup', '0::/machine.slice/libpod-seat.scope/container\n');
    put('sys/fs/cgroup/machine.slice/memory.max', 'max\n');
    put('sys/fs/cgroup/machine.slice/libpod-seat.scope/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/libpod-seat.scope/memory.current', `${Math.round(3.6 * GIB)}\n`);
    put('sys/fs/cgroup/machine.slice/libpod-seat.scope/memory.stat', 'anon 1\ninactive_file 0\n');
    put('sys/fs/cgroup/machine.slice/libpod-seat.scope/container/memory.max', 'max\n');
    put('sys/fs/cgroup/machine.slice/libpod-seat.scope/container/memory.current', `${3 * GIB}\n`);
    const r = meter().read();
    expect(r).toMatchObject({ container: true, memTotalBytes: 4 * GIB });
    expect(r.memAvailableBytes).toBeCloseTo(0.4 * GIB, -3);
  });

  // Issue #2499 part 4: seats on one VM share its kernel. The reading names the kernel (its boot id) and, under a cgroup
  // limit, the kernel's own memory, so the hopper counts the machines on one host as one pool.
  it('names its kernel by its boot id; under a cgroup limit it says the kernel\'s memory too', () => {
    put('proc/sys/kernel/random/boot_id', 'b0a1-c2d3\n');
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    expect(meter().read()).toMatchObject({ bootId: 'b0a1-c2d3', memTotalBytes: 14 * GIB });
    expect(meter().read()).not.toHaveProperty('kernelMemTotalBytes');
    put('sys/fs/cgroup/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/memory.current', `${1 * GIB}\n`);
    expect(meter().read()).toMatchObject({ bootId: 'b0a1-c2d3', memTotalBytes: 4 * GIB, kernelMemTotalBytes: 14 * GIB, kernelMemAvailableBytes: 10 * GIB });
  });

  // Issue #2499 part 5: memory pressure (PSI). A seat near its cgroup limit reclaims, and its tasks stall on memory
  // although some memory is still available. The reading says the share of the last 10 s a task waited on memory.
  it('says its memory pressure: the limited cgroup\'s, else the kernel\'s', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/pressure/memory', 'some avg10=1.50 avg60=0.80 avg300=0.10 total=12345\nfull avg10=0.25 avg60=0.10 avg300=0.00 total=678\n');
    expect(meter().read()).toMatchObject({ memPressure: { someAvg10: 1.5, fullAvg10: 0.25 } });
    put('proc/self/cgroup', '0::/machine.slice/seat.scope\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.current', `${3 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.pressure', 'some avg10=42.00 avg60=30.00 avg300=9.00 total=99\nfull avg10=12.00 avg60=8.00 avg300=1.00 total=9\n');
    expect(meter().read()).toMatchObject({ memTotalBytes: 4 * GIB, memPressure: { someAvg10: 42, fullAvg10: 12 } });
  });

  // Issue #2499 part 7: a seat at its cgroup limit has processes killed for memory (memory.events oom_kill) while its
  // reading can still show memory available. The meter says when it last saw that count grow: the hopper starts no job
  // there for a while after. The first read has no count before it, so it says none.
  it('says when it last saw a process killed for memory: the limited cgroup\'s memory.events, else the kernel\'s', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/vmstat', 'nr_free_pages 1\noom_kill 3\n');
    const m = meter();
    expect(m.read()).not.toHaveProperty('memOomKillAt');
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read()).not.toHaveProperty('memOomKillAt');
    put('proc/vmstat', 'nr_free_pages 1\noom_kill 4\n');
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().memOomKillAt).toBe(new Date(1_060_000).toISOString());
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().memOomKillAt).toBe(new Date(1_060_000).toISOString());

    put('proc/self/cgroup', '0::/machine.slice/seat.scope\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.max', `${4 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.current', `${3 * GIB}\n`);
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.events', 'low 0\nhigh 0\nmax 21000\noom 5\noom_kill 5\n');
    const seat = meter();
    expect(seat.read()).not.toHaveProperty('memOomKillAt');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.events', 'low 0\nhigh 0\nmax 23000\noom 6\noom_kill 6\n');
    put('proc/vmstat', 'oom_kill 4\n');
    seat.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(seat.read()).toMatchObject({ memTotalBytes: 4 * GIB, memOomKillAt: new Date(1_030_000).toISOString() });
  });

  it('no pressure file (an older kernel, PSI off): no memory pressure', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    expect(meter().read()).not.toHaveProperty('memPressure');
  });

  // Issue #2499: a job on its own wait holds no lane, but its scope keeps its builds. Each job scope's memory is read, and
  // a scope outside the cgroup whose limit the reading is (a sibling of the hopper's own unit) is taken off its memory.
  describe('job scopes (issue #2499)', () => {
    const USER = 'sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service';
    const scope = (id: string, current: number, inactive: number) => {
      put(`${USER}/app.slice/hopper-job-${id}.scope/memory.current`, `${current}\n`);
      put(`${USER}/app.slice/hopper-job-${id}.scope/memory.stat`, `anon 1\ninactive_file ${inactive}\n`);
    };

    it('a scope outside the limited cgroup: its memory is said, and taken off the memory available', () => {
      put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
      put('proc/self/cgroup', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/hopper.service\n');
      put(`${USER}/app.slice/hopper.service/memory.max`, `${4 * GIB}\n`);
      put(`${USER}/app.slice/hopper.service/memory.current`, `${1 * GIB}\n`);
      scope('j1', 1.5 * GIB, 0.5 * GIB);
      put(`${USER}/app.slice/other.scope/memory.current`, `${1 * GIB}\n`);
      const r = meter().read();
      expect(r).toMatchObject({ container: true, memTotalBytes: 4 * GIB, memAvailableBytes: 2 * GIB, jobMemoryBytes: { j1: 1 * GIB } });
    });

    it('a scope inside the limited cgroup: its memory is said, and is already in the use read', () => {
      put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
      put('proc/self/cgroup', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/hopper.service\n');
      put(`${USER}/memory.max`, `${6 * GIB}\n`);
      put(`${USER}/memory.current`, `${3 * GIB}\n`);
      scope('j1', 1 * GIB, 0);
      scope('j2', 0.5 * GIB, 0);
      expect(meter().read()).toMatchObject({ memTotalBytes: 6 * GIB, memAvailableBytes: 3 * GIB, jobMemoryBytes: { j1: 1 * GIB, j2: 0.5 * GIB } });
    });

    it('no cgroup limit: the scopes of its own user manager are said; the host\'s memory has them', () => {
      put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
      put('proc/self/cgroup', '0::/\n');
      scope('j1', 2 * GIB, 0);
      const r = meter({ uid: 1000 }).read();
      expect(r).toMatchObject({ memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB, jobMemoryBytes: { j1: 2 * GIB } });
      expect(meter({ uid: 1001 }).read()).not.toHaveProperty('jobMemoryBytes');
    });
  });

  it('a cgroup with no limits (`max`) reads the host', () => {
    put('proc/meminfo', `MemTotal: ${16 * GIB / KIB} kB\nMemAvailable: ${8 * GIB / KIB} kB`);
    put('sys/fs/cgroup/memory.max', 'max\n');
    put('sys/fs/cgroup/cpu.max', 'max 100000\n');
    const r = meter().read();
    expect(r).toMatchObject({ cores: 2, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB });
    expect(r).not.toHaveProperty('container');
  });

  describe('in WSL (issue #868): the VM keeps its page cache, so Windows loses more than Linux says is used', () => {
    const wslMeminfo = [
      `MemTotal:       ${20 * GIB / KIB} kB`, `MemFree:         ${1 * GIB / KIB} kB`, `MemAvailable:    ${13 * GIB / KIB} kB`,
    ].join('\n');
    const tick = () => new Promise((r) => setImmediate(r));

    it('the memory the VM holds is MemTotal less MemFree, page cache included', () => {
      put('proc/version', 'Linux version 6.6.87.2-microsoft-standard-WSL2 (gcc) #1 SMP\n');
      put('proc/meminfo', wslMeminfo);
      const r = meter({ hostMemory: async () => undefined }).read();
      expect(r).toMatchObject({ wsl: true, memTotalBytes: 20 * GIB, memAvailableBytes: 13 * GIB, vmHeldBytes: 19 * GIB });
    });

    it('Windows\' free memory comes in the background: the next read carries it, and it is read again after a minute', async () => {
      put('proc/version', 'Linux version 6.6.87.2-microsoft-standard-WSL2\n');
      put('proc/meminfo', wslMeminfo);
      let asked = 0;
      const m = meter({ hostMemory: async () => { asked += 1; return { freeBytes: (4 - asked) * GIB, totalBytes: 32 * GIB }; } });
      expect(m.read()).not.toHaveProperty('hostMemFreeBytes');
      await tick();
      expect(m.read()).toMatchObject({ hostMemFreeBytes: 3 * GIB, hostMemTotalBytes: 32 * GIB });
      expect(asked).toBe(1);
      m.advance(61_000, [cpu(0, 0), cpu(0, 0)]);
      m.read();
      await tick();
      expect(m.read()).toMatchObject({ hostMemFreeBytes: 2 * GIB });
      expect(asked).toBe(2);
    });

    it('no host reading (no interop, as in a container): the VM\'s figures only, and the old host reading is dropped when stale', async () => {
      put('proc/version', 'Linux version 6.6.87.2-microsoft-standard-WSL2\n');
      put('proc/meminfo', wslMeminfo);
      let answer: { freeBytes: number; totalBytes: number } | undefined = { freeBytes: 3 * GIB, totalBytes: 32 * GIB };
      const m = meter({ hostMemory: async () => answer });
      m.read();
      await tick();
      expect(m.read().hostMemFreeBytes).toBe(3 * GIB);
      answer = undefined;
      m.advance(6 * 60_000, [cpu(0, 0), cpu(0, 0)]);
      m.read();
      await tick();
      const r = m.read();
      expect(r).not.toHaveProperty('hostMemFreeBytes');
      expect(r.vmHeldBytes).toBe(19 * GIB);
    });

    it('not WSL: no VM figure, and the host is never asked', async () => {
      put('proc/version', 'Linux version 6.8.0-45-generic\n');
      put('proc/meminfo', wslMeminfo);
      let asked = 0;
      const m = meter({ hostMemory: async () => { asked += 1; return undefined; } });
      const r = m.read();
      await tick();
      expect(r).not.toHaveProperty('wsl');
      expect(r).not.toHaveProperty('vmHeldBytes');
      expect(asked).toBe(0);
    });

    it('Windows\' answer: free and total physical memory in KiB, one line', () => {
      expect(readWindowsMemory('3145728 33554432\r\n')).toEqual({ freeBytes: 3 * GIB, totalBytes: 32 * GIB });
      expect(readWindowsMemory('')).toBeUndefined();
      expect(readWindowsMemory('9 3')).toBeUndefined();
      expect(readWindowsMemory('Get-CimInstance: not found')).toBeUndefined();
    });
  });

  describe('in a Kubernetes pod (issue #1289): its limits, never WSL', () => {
    const POD = { KUBERNETES_SERVICE_HOST: '10.96.0.1' };
    const nodeMeminfo = `MemTotal: ${64 * GIB / KIB} kB\nMemFree: ${1 * GIB / KIB} kB\nMemAvailable: ${60 * GIB / KIB} kB`;

    it('a pod with cgroup limits reads them: its memory limit and its CPU limit as cores', () => {
      put('proc/meminfo', nodeMeminfo);
      put('sys/fs/cgroup/memory.max', `${2 * GIB}\n`);
      put('sys/fs/cgroup/memory.current', `${1 * GIB}\n`);
      put('sys/fs/cgroup/cpu.max', '50000 100000\n');
      expect(meter({ env: POD }).read()).toMatchObject({ container: true, cores: 0.5, memTotalBytes: 2 * GIB, memAvailableBytes: 1 * GIB });
    });

    it('a cgroup with no limits reads the limits the Downward API gives, against the cgroup\'s own use', () => {
      put('proc/meminfo', nodeMeminfo);
      put('sys/fs/cgroup/memory.max', 'max\n');
      put('sys/fs/cgroup/memory.current', `${3 * GIB}\n`);
      put('sys/fs/cgroup/cpu.max', 'max 100000\n');
      const r = meter({ env: { ...POD, HOPPER_POD_CPU_LIMIT: '4000', HOPPER_POD_MEMORY_LIMIT: String(8 * GIB) } }).read();
      expect(r).toMatchObject({ container: true, cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 5 * GIB });
    });

    it('a pod is a container, so the memory alert does not watch it; a node in WSL is not WSL to it, and Windows is never asked', async () => {
      put('proc/version', 'Linux version 6.6.87.2-microsoft-standard-WSL2\n');
      put('proc/meminfo', nodeMeminfo);
      let asked = 0;
      const r = meter({ env: POD, hostMemory: async () => { asked += 1; return undefined; } }).read();
      await new Promise((res) => setImmediate(res));
      expect(r.container).toBe(true);
      expect(r).not.toHaveProperty('wsl');
      expect(r).not.toHaveProperty('vmHeldBytes');
      expect(asked).toBe(0);
    });
  });

  it('reads this machine for real by default', () => {
    const r = createResourceMeter()();
    expect(r.cores).toBeGreaterThan(0);
    expect(r.memTotalBytes).toBeGreaterThan(0);
    expect(r.memAvailableBytes).toBeLessThanOrEqual(r.memTotalBytes);
  });
});
