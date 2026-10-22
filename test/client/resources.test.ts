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
function meter(o: { platform?: string; cpus?: () => CpuTimes[]; hostMemory?: HostMemoryReader; env?: Record<string, string>; node?: string } = {}) {
  let t = 1_000_000;
  let times = [cpu(0, 0), cpu(0, 0)];
  const read = createResourceMeter({
    root, platform: o.platform ?? 'linux', now: () => t, env: o.env ?? {}, ...(o.hostMemory ? { hostMemory: o.hostMemory } : {}), ...(o.node ? { node: o.node } : {}),
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
