// Large page allocation failures in the kernel log (issue #2622 part 6, src/client/kernel-log.ts), as the machine's meter
// says them: /dev/kmsg and /proc/uptime read from a fake root here, so the test does not depend on the host's kernel log.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceMeter } from '../../src/client/resources.ts';

const KIB = 1024;
const GIB = 1024 ** 3;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-kmsg-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const cpu = () => ({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });

function meter() {
  let t = 1_000_000;
  const read = createResourceMeter({ root, platform: 'linux', now: () => t, env: {}, cpus: () => [cpu()], parallelism: () => 2, loadavg: () => [0, 0, 0] });
  return { read, advance(ms: number) { t += ms; } };
}

describe('a machine\'s large page allocation failures', () => {
  // Issue #2622 part 6: a WSL guest full of fragmented memory fails the large allocations hv_sock needs (order:7), and
  // wsl.exe hangs next. The meter reads the kernel log (/dev/kmsg, each record's time since boot) and says the page
  // allocation failures of order 4 or more in the last 10 minutes, by /proc/uptime; smaller orders and older ones are not counted.
  it('says the large page allocation failures the kernel logged in the last 10 minutes', () => {
    const fail = (seq: number, s: number, order: number) => `4,${seq},${s * 1e6},-;kworker/u16:2: page allocation failure: order:${order}, mode:0xcc0(GFP_KERNEL), nodemask=(null)\n SUBSYSTEM=vmbus\n`;
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/uptime', '1000.00 4000.00\n');
    put('dev/kmsg', [fail(1, 300, 7), '6,2,400000000,-;eth0: link up\n', fail(3, 700, 7), fail(4, 800, 2), fail(5, 900, 4)].join(''));
    const m = meter();
    expect(m.read().memAllocFailures).toEqual({ count: 2, maxOrder: 7 });
    writeFileSync(join(root, 'dev/kmsg'), fail(6, 950, 5), { flag: 'a' });
    m.advance(30_000);
    expect(m.read().memAllocFailures).toEqual({ count: 3, maxOrder: 7 });
    put('proc/uptime', '1400.00 4000.00\n');
    m.advance(30_000);
    expect(m.read().memAllocFailures).toEqual({ count: 2, maxOrder: 5 });
    put('proc/uptime', '1600.00 4000.00\n');
    m.advance(30_000);
    expect(m.read()).not.toHaveProperty('memAllocFailures');
  });

  it('no kernel log it may read: no allocation failures', () => {
    put('proc/meminfo', `MemTotal: ${14 * GIB / KIB} kB\nMemAvailable: ${10 * GIB / KIB} kB`);
    put('proc/uptime', '1000.00 4000.00\n');
    expect(meter().read()).not.toHaveProperty('memAllocFailures');
  });
});
