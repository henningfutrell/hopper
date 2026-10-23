// The allocation failure watch (issue #2622 part 6): a machine whose kernel logged a burst of large page allocation
// failures (order 4 or more, ALLOC_FAILURE_BURST in the last 10 minutes) is told once (machine.allocation_failures), and
// once more when the last 10 minutes have none (machine.allocation_failures_ended). In a WSL VM they come before wsl.exe
// hangs. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot, ResourceReading } from '../../src/domain/types.ts';
import { ALLOC_FAILURE_BURST, createAllocFailureWatch, type AllocFailureEvent } from '../../src/machines/alloc-failure-watch.ts';
import { allocFailureBurst } from '../../ui/src/model/machine-list.ts';

const GIB = 1024 ** 3;
const at = (min: number) => new Date(Date.parse('2026-10-23T10:00:00.000Z') + min * 60_000).toISOString();
const reading = (count?: number, maxOrder = 7): ResourceReading =>
  ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 1 * GIB, wsl: true, ...(count ? { memAllocFailures: { count, maxOrder } } : {}) });
const machine = (resources: ResourceReading | undefined, online = true): MachineSnapshot =>
  ({ id: 'local', label: 'this machine', online, ...(resources ? { resources } : {}) }) as unknown as MachineSnapshot;

function watch() {
  const told: AllocFailureEvent[] = [];
  const w = createAllocFailureWatch({ tell: (e) => told.push(e) });
  return { told, see: (m: MachineSnapshot, min: number) => w.observe([m], at(min)) };
}

describe('the allocation failure watch', () => {
  it('a burst is told once, with its count and highest order; none in the last 10 minutes is told once', () => {
    const w = watch();
    w.see(machine(reading()), 0);
    w.see(machine(reading(ALLOC_FAILURE_BURST - 1)), 1);
    expect(w.told).toEqual([]);
    w.see(machine(reading(ALLOC_FAILURE_BURST)), 2);
    w.see(machine(reading(ALLOC_FAILURE_BURST + 5, 9)), 3);
    expect(w.told).toEqual([{
      type: 'machine.allocation_failures', machineId: 'local',
      data: { machineId: 'local', label: 'this machine', count: ALLOC_FAILURE_BURST, maxOrder: 7, since: at(2) },
    }]);
    w.see(machine(reading(1)), 4);
    expect(w.told).toHaveLength(1);
    w.see(machine(reading()), 14);
    w.see(machine(reading()), 15);
    expect(w.told.map((e) => e.type)).toEqual(['machine.allocation_failures', 'machine.allocation_failures_ended']);
    expect(w.told[1]).toEqual({ type: 'machine.allocation_failures_ended', machineId: 'local', data: { machineId: 'local', label: 'this machine', since: at(2) } });
  });

  it('a machine offline or with no reading keeps what was told; one gone from the list is forgotten', () => {
    const w = watch();
    w.see(machine(reading(ALLOC_FAILURE_BURST)), 0);
    w.see(machine(undefined, false), 1);
    w.see(machine(undefined), 2);
    expect(w.told).toHaveLength(1);
    w.see(machine(reading(ALLOC_FAILURE_BURST)), 3);
    expect(w.told).toHaveLength(1);
    const g = createAllocFailureWatch({ tell: (e) => w.told.push(e) });
    g.observe([machine(reading(ALLOC_FAILURE_BURST))], at(4));
    g.observe([], at(5));
    g.observe([machine(reading())], at(6));
    expect(w.told.map((e) => e.type)).toEqual(['machine.allocation_failures', 'machine.allocation_failures']);
  });

  it('the Machines page warns at the same burst (it imports no code of src/)', () => {
    expect(allocFailureBurst(reading(ALLOC_FAILURE_BURST))).toBe(true);
    expect(allocFailureBurst(reading(ALLOC_FAILURE_BURST - 1))).toBe(false);
    expect(allocFailureBurst(reading())).toBe(false);
  });
});
