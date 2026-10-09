// A machine's resources (issue #560): CPU, memory and swap as the machine's own meter reads them — this machine,
// and a client target's client in its `/release` answer. CPU busy is the share of CPU time busy between two
// reads; memory is what is available, not what is free; a machine in a container with cgroup limits reads its
// limits and its own use, not the host's. Read from a fake root here, so the test does not depend on the host.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceMeter, type CpuTimes } from '../../src/client/resources.ts';

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
function meter(o: { platform?: string; cpus?: () => CpuTimes[] } = {}) {
  let t = 1_000_000;
  let times = [cpu(0, 0), cpu(0, 0)];
  const read = createResourceMeter({
    root, platform: o.platform ?? 'linux', now: () => t,
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

  it('reads this machine for real by default', () => {
    const r = createResourceMeter()();
    expect(r.cores).toBeGreaterThan(0);
    expect(r.memTotalBytes).toBeGreaterThan(0);
    expect(r.memAvailableBytes).toBeLessThanOrEqual(r.memTotalBytes);
  });
});
