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

  it('in WSL (issue #868): the memory the VM holds, MemTotal less MemFree', () => {
    const wsl = printed.replace('hopper-res 8', `hopper-res MemFree:        ${1 * GIB / KIB} kB\nhopper-res wsl\nhopper-res 8`);
    expect(readResources(wsl)).toMatchObject({ wsl: true, vmHeldBytes: 15 * GIB });
    // Not WSL: MemFree is read, but no VM figure.
    expect(readResources(printed.replace('hopper-res 8', `hopper-res MemFree:        ${1 * GIB / KIB} kB\nhopper-res 8`))).not.toHaveProperty('vmHeldBytes');
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

  it('a client\'s Node version (issue #2479): kept when it reads as one, its floor judged here, not taken from the client', () => {
    const r = { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB };
    expect(resourcesOf({ ...r, node: 'v26.12.1', nodeFloor: '99.0.0' })).toEqual({ ...r, node: 'v26.12.1' });
    expect(resourcesOf({ ...r, node: 'v26.8.2' })).toEqual({ ...r, node: 'v26.8.2', nodeFloor: '26.12.1' });
    expect(resourcesOf({ ...r, node: 'v24.22.0' })).toEqual({ ...r, node: 'v24.22.0', nodeFloor: '24.22.1' });
    expect(resourcesOf({ ...r, node: 'v26.8.2\nx' })).toEqual(r);
    expect(resourcesOf({ ...r, node: 26 })).toEqual(r);
  });

  it('a WSL client\'s VM figure and Windows\' memory (issue #868), each dropped when not sane', () => {
    const r = { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB };
    const wsl = { ...r, wsl: true, vmHeldBytes: 7 * GIB, hostMemFreeBytes: 3 * GIB, hostMemTotalBytes: 32 * GIB };
    expect(resourcesOf(wsl)).toEqual(wsl);
    expect(resourcesOf({ ...wsl, vmHeldBytes: 9 * GIB })).not.toHaveProperty('vmHeldBytes');
    expect(resourcesOf({ ...wsl, hostMemFreeBytes: 33 * GIB })).not.toHaveProperty('hostMemFreeBytes');
    expect(resourcesOf({ ...wsl, hostMemTotalBytes: undefined })).not.toHaveProperty('hostMemFreeBytes');
  });

  it('a WSL client\'s Windows link (issue #712): kept when sane, else dropped', () => {
    const r = { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB, wsl: true };
    const link = { url: 'http://localhost:4790/job/address', mode: 'nat', ok: false, error: 'Unable to connect to the remote server', at: '2026-10-13T10:00:00.000Z' };
    expect(resourcesOf({ ...r, windowsLink: link })).toEqual({ ...r, windowsLink: link });
    expect(resourcesOf({ ...r, windowsLink: { url: link.url, ok: true, status: 200, at: link.at } })?.windowsLink).toEqual({ url: link.url, ok: true, status: 200, at: link.at });
    for (const url of ['http://127.0.0.1:4790/job/address', 'http://localhost:4790/api/health']) {
      expect(resourcesOf({ ...r, windowsLink: { ...link, url } })?.windowsLink?.url).toBe(url); // only 127.0.0.1 answered; a client before the address check
    }
    for (const url of ['http://hopper.example.org/job/address', 'http://127.0.0.2:4790/job/address', 'http://localhost:4790/api/jobs']) {
      expect(resourcesOf({ ...r, windowsLink: { ...link, url } })).not.toHaveProperty('windowsLink');
    }
    expect(resourcesOf({ ...r, windowsLink: { ...link, ok: 'no' } })).not.toHaveProperty('windowsLink');
    expect(resourcesOf({ ...r, windowsLink: { ...link, at: 'yesterday' } })).not.toHaveProperty('windowsLink');
    expect(resourcesOf({ ...r, windowsLink: { ...link, mode: 'NAT; rm -rf' } })?.windowsLink).not.toHaveProperty('mode');
    expect(resourcesOf({ ...r, windowsLink: { ...link, error: 'x'.repeat(500) } })?.windowsLink?.error).toHaveLength(200);
    expect(resourcesOf({ cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB, windowsLink: link })).not.toHaveProperty('windowsLink');
  });
});
