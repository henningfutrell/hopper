// Issue #2499 part 9: a seat with a CPU quota (cpu.max), its own or a cgroup's above it, is held back when its tasks want
// more CPU than the quota gives (cpu.stat nr_throttled of nr_periods). The meter says the share of periods throttled since
// its read before: the most of each limited cgroup. The first read has no count before it. Read from a fake root.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceMeter, type CpuTimes } from '../../src/client/resources.ts';

const KIB = 1024;
const GIB = 1024 ** 3;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-thr-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const cpu = (busy: number, idle: number): CpuTimes => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });

/** A meter over a fake root: the clock moves as the test says. */
function meter() {
  let t = 1_000_000;
  const read = createResourceMeter({
    root, platform: 'linux', now: () => t, env: {}, cpus: () => [cpu(0, 0)], parallelism: () => 2, loadavg: () => [0, 0, 0],
    totalmem: () => 16 * GIB, freemem: () => 4 * GIB,
  });
  return { read, advance(ms: number, _next?: CpuTimes[]) { t += ms; } };
}

describe('a machine\'s CPU throttle', () => {
  it('says the share of CPU periods its quota throttled since the read before: the most of each cgroup with a quota', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/self/cgroup', '0::/machine.slice/seat.scope\n');
    put('sys/fs/cgroup/machine.slice/cpu.max', '400000 100000\n');
    put('sys/fs/cgroup/machine.slice/cpu.stat', 'usage_usec 1\nnr_periods 1000\nnr_throttled 10\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/cpu.max', '200000 100000\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/cpu.stat', 'usage_usec 1\nnr_periods 500\nnr_throttled 100\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/memory.max', 'max\n');
    const m = meter();
    expect(m.read()).not.toHaveProperty('cpuThrottledFrac');
    put('sys/fs/cgroup/machine.slice/cpu.stat', 'usage_usec 1\nnr_periods 1300\nnr_throttled 70\n');
    put('sys/fs/cgroup/machine.slice/seat.scope/cpu.stat', 'usage_usec 1\nnr_periods 800\nnr_throttled 280\n');
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().cpuThrottledFrac).toBeCloseTo(0.6);
    m.advance(100, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().cpuThrottledFrac).toBeCloseTo(0.6);
    put('sys/fs/cgroup/machine.slice/seat.scope/cpu.stat', 'usage_usec 1\nnr_periods 1100\nnr_throttled 280\n');
    put('sys/fs/cgroup/machine.slice/cpu.stat', 'usage_usec 1\nnr_periods 1600\nnr_throttled 100\n');
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read().cpuThrottledFrac).toBeCloseTo(0.1);
  });

  it('no CPU quota on its cgroups (cpu.max is max): no CPU throttle', () => {
    put('proc/self/cgroup', '0::/user.slice\n');
    put('sys/fs/cgroup/user.slice/cpu.max', 'max 100000\n');
    put('sys/fs/cgroup/user.slice/cpu.stat', 'usage_usec 1\nnr_periods 0\nnr_throttled 0\n');
    const m = meter();
    m.read();
    m.advance(30_000, [cpu(0, 0), cpu(0, 0)]);
    expect(m.read()).not.toHaveProperty('cpuThrottledFrac');
  });
});
