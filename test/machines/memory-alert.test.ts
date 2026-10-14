// The memory alert (issue #868): a machine's free memory — Windows' own for a WSL machine that reads it, else memory
// available — under the threshold for the minutes set tells a person once (machine.memory_low), and once more when it
// is back over (machine.memory_recovered). A WSL machine with no Windows reading and a container are not watched:
// their memory available is not what the host has free. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot, MemoryAlert, ResourceReading } from '../../src/domain/types.ts';
import { createMemoryWatch, freeMemoryOf, type MemoryAlertEvent } from '../../src/machines/memory-alert.ts';

const GIB = 1024 ** 3;
const MIN = 60_000;
const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

const wsl = (hostFreeGib: number): ResourceReading => ({
  cores: 8, memTotalBytes: 20 * GIB, memAvailableBytes: 13 * GIB, wsl: true, vmHeldBytes: 19 * GIB, hostMemFreeBytes: hostFreeGib * GIB, hostMemTotalBytes: 32 * GIB,
});
const machine = (resources: ResourceReading | undefined, online = true): MachineSnapshot =>
  ({ id: 'win', online, ...(resources ? { resources } : {}) }) as unknown as MachineSnapshot;

function watch(alert: MemoryAlert | undefined) {
  const told: MemoryAlertEvent[] = [];
  const w = createMemoryWatch({ alert: () => alert, tell: (e) => told.push(e) });
  return { told, see: (m: MachineSnapshot, min: number) => w.observe([m], at(min)) };
}

describe('the free memory a machine has', () => {
  it('a WSL machine: Windows\' free memory, not the VM\'s memory available', () => {
    expect(freeMemoryOf(wsl(3))).toEqual({ freeBytes: 3 * GIB, totalBytes: 32 * GIB, of: 'windows' });
  });

  it('elsewhere memory available; a WSL machine with no Windows reading and a container: none', () => {
    expect(freeMemoryOf({ cores: 8, memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB })).toEqual({ freeBytes: 4 * GIB, totalBytes: 16 * GIB, of: 'machine' });
    const { hostMemFreeBytes: _f, hostMemTotalBytes: _t, ...noHost } = wsl(3);
    expect(freeMemoryOf(noHost)).toBeUndefined();
    expect(freeMemoryOf({ cores: 2, memTotalBytes: 4 * GIB, memAvailableBytes: 1 * GIB, container: true })).toBeUndefined();
  });
});

describe('the memory alert', () => {
  const alert: MemoryAlert = { freeBytes: 5 * GIB, minutes: 5 };

  it('under the threshold for the minutes set: told once, with when it went under', () => {
    const w = watch(alert);
    w.see(machine(wsl(4)), 0);
    w.see(machine(wsl(3)), 4);
    expect(w.told).toEqual([]);
    w.see(machine(wsl(3)), 5);
    w.see(machine(wsl(2)), 6);
    expect(w.told).toEqual([{
      type: 'machine.memory_low', machineId: 'win',
      data: { machineId: 'win', of: 'windows', freeBytes: 3 * GIB, totalBytes: 32 * GIB, thresholdBytes: 5 * GIB, since: at(0) },
    }]);
  });

  it('back over the threshold: told it recovered, once; a short dip under is not told', () => {
    const w = watch(alert);
    w.see(machine(wsl(3)), 0);
    w.see(machine(wsl(3)), 5);
    w.see(machine(wsl(8)), 6);
    w.see(machine(wsl(9)), 7);
    expect(w.told.map((e) => e.type)).toEqual(['machine.memory_low', 'machine.memory_recovered']);
    expect(w.told[1]!.data).toEqual({ machineId: 'win', of: 'windows', freeBytes: 8 * GIB, totalBytes: 32 * GIB, thresholdBytes: 5 * GIB });
    w.see(machine(wsl(3)), 10);
    w.see(machine(wsl(8)), 12);
    expect(w.told).toHaveLength(2);
  });

  it('a machine offline or with no reading breaks the stretch under; no alert set: nothing is told', () => {
    const w = watch(alert);
    w.see(machine(wsl(3)), 0);
    w.see(machine(undefined, false), 3);
    w.see(machine(wsl(3)), 4);
    w.see(machine(wsl(3)), 8);
    expect(w.told).toEqual([]);
    const off = watch(undefined);
    off.see(machine(wsl(1)), 0);
    off.see(machine(wsl(1)), 60);
    expect(off.told).toEqual([]);
  });

  it('0 minutes: told at the first reading under', () => {
    const w = watch({ freeBytes: 5 * GIB, minutes: 0 });
    w.see(machine(wsl(4)), 0);
    expect(w.told.map((e) => e.type)).toEqual(['machine.memory_low']);
  });
});
