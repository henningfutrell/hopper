// A machine's resources read over ssh (issue #560): the lines RESOURCES_COMMAND prints in an ssh target's
// probe — two /proc/stat cpu lines a second apart, the load averages, the memory lines and the core count — and
// a client's answer checked before it is believed. Pure.
import { describe, expect, it } from 'vitest';
import { readResources, resourcesOf } from '../../src/machines/resources.ts';

const KIB = 1024;
const GIB = 1024 ** 3;

const printed = [
  '/home/far',
  'hopper-disk 104857600 52428800',
  'hopper-res cpu  100 0 100 700 100 0 0 0 0 0',
  'hopper-res cpu  300 0 200 1100 200 0 0 0 0 0',
  'hopper-res 0.52 0.61 0.70 2/345 6789',
  `hopper-res MemTotal:       ${16 * GIB / KIB} kB`,
  `hopper-res MemAvailable:   ${10 * GIB / KIB} kB`,
  `hopper-res SwapTotal:      ${8 * GIB / KIB} kB`,
  `hopper-res SwapFree:       ${6 * GIB / KIB} kB`,
  'hopper-res 8',
  'hopper-work-tree-ok',
].join('\n');

describe('resources an ssh target prints', () => {
  it('CPU busy between the two cpu lines (iowait counts as idle), load, memory available, swap used, cores', () => {
    // busy: user+nice+system+irq+softirq+steal moved 200+100 = 300; idle+iowait moved 400+100 = 500.
    expect(readResources(printed)).toEqual({
      cores: 8, cpuBusyFrac: 300 / 800, load: [0.52, 0.61, 0.7],
      memTotalBytes: 16 * GIB, memAvailableBytes: 10 * GIB, swapTotalBytes: 8 * GIB, swapUsedBytes: 2 * GIB,
    });
  });

  it('no resource lines (a machine with no /proc): none', () => {
    expect(readResources('/home/far\nhopper-disk 1 1\nhopper-work-tree-ok')).toBeUndefined();
  });

  it('one cpu line only: memory without CPU busy', () => {
    const one = printed.split('\n').filter((l) => !l.startsWith('hopper-res cpu  300')).join('\n');
    const r = readResources(one)!;
    expect(r).not.toHaveProperty('cpuBusyFrac');
    expect(r.memTotalBytes).toBe(16 * GIB);
  });
});

describe('resources a client answers', () => {
  it('kept when whole and sane; numbers out of range or missing are no reading', () => {
    const r = { cores: 4, cpuBusyFrac: 0.25, load: [1, 2, 3], memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB };
    expect(resourcesOf(r)).toEqual(r);
    expect(resourcesOf({ ...r, container: true, swapTotalBytes: 1, swapUsedBytes: 0 })).toEqual({ ...r, container: true, swapTotalBytes: 1, swapUsedBytes: 0 });
    expect(resourcesOf(undefined)).toBeUndefined();
    expect(resourcesOf({ ...r, memTotalBytes: 'x' })).toBeUndefined();
    expect(resourcesOf({ ...r, cores: 0 })).toBeUndefined();
    expect(resourcesOf({ ...r, memAvailableBytes: 9 * GIB })).toBeUndefined();
    // A CPU busy outside 0..1 or a bad load is dropped, the rest kept.
    expect(resourcesOf({ ...r, cpuBusyFrac: 2, load: ['a'] })).toEqual({ cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB });
  });
});
