// The disk watch (issue #2494): a machine whose disk turns low is told once (machine.disk_low), told again when it
// turns critical, and once more when it is no longer low (machine.disk_ok). What the event log last told for each
// machine is where it starts, so a restart tells nothing twice. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createDiskWatch, type DiskEvent } from '../../src/machines/disk-watch.ts';

const GIB = 1024 ** 3;
const at = (min: number) => new Date(Date.parse('2026-10-22T10:00:00.000Z') + min * 60_000).toISOString();
const machine = (id: string, freeGiB: number | undefined, o: { online?: boolean } = {}): MachineSnapshot => ({
  id, label: `seat ${id}`, online: o.online ?? true,
  ...(freeGiB === undefined ? {} : { disk: { freeBytes: freeGiB * GIB, totalBytes: 100 * GIB, low: freeGiB < 10, ...(freeGiB < 2 ? { critical: true } : {}) } }),
}) as unknown as MachineSnapshot;

function watch(told: Array<[string, 'low' | 'critical']> = []) {
  const events: DiskEvent[] = [];
  const w = createDiskWatch({ told: () => told, tell: (e) => events.push(e) });
  return { events, see: (ms: MachineSnapshot[], min = 0) => w.observe(ms, at(min)) };
}

describe('the disk watch (issue #2494)', () => {
  it('tells a machine whose disk turns low once, and once more when it is no longer low', () => {
    const w = watch();
    w.see([machine('l1', 50)], 0);
    expect(w.events).toEqual([]);
    w.see([machine('l1', 5)], 1);
    w.see([machine('l1', 4)], 2);
    expect(w.events).toEqual([{ type: 'machine.disk_low', machineId: 'l1', data: { machineId: 'l1', label: 'seat l1', freeBytes: 5 * GIB, totalBytes: 100 * GIB, critical: false } }]);
    w.see([machine('l1', 30)], 3);
    w.see([machine('l1', 31)], 4);
    expect(w.events.slice(1)).toEqual([{ type: 'machine.disk_ok', machineId: 'l1', data: { machineId: 'l1', label: 'seat l1', freeBytes: 30 * GIB, totalBytes: 100 * GIB } }]);
  });

  it('tells it again when it turns critical, and not when it is only low again after', () => {
    const w = watch();
    w.see([machine('l1', 5)]);
    w.see([machine('l1', 1)]);
    w.see([machine('l1', 0.5)]);
    w.see([machine('l1', 5)]);
    expect(w.events.map((e) => [e.type, e.type === 'machine.disk_low' && e.data.critical])).toEqual([['machine.disk_low', false], ['machine.disk_low', true]]);
    w.see([machine('l1', 50)]);
    expect(w.events.map((e) => e.type)).toEqual(['machine.disk_low', 'machine.disk_low', 'machine.disk_ok']);
  });

  it('tells a machine critical at its first reading once, as critical', () => {
    const w = watch();
    w.see([machine('l1', 1)]);
    w.see([machine('l1', 5)]);
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: 'machine.disk_low', data: { critical: true } });
  });

  it('starts from what the event log told: a machine told low and still low is not told again; one now roomy is told ok', () => {
    const w = watch([['l1', 'low'], ['l2', 'low'], ['l3', 'critical']]);
    w.see([machine('l1', 5), machine('l2', 50), machine('l3', 1)]);
    expect(w.events.map((e) => `${e.type} ${e.machineId}`)).toEqual(['machine.disk_ok l2']);
    w.see([machine('l1', 1)]);
    expect(w.events.map((e) => `${e.type} ${e.machineId}`)).toEqual(['machine.disk_ok l2', 'machine.disk_low l1']);
  });

  it('a machine offline or with no reading keeps its state: nothing is told until a reading says otherwise', () => {
    const w = watch();
    w.see([machine('l1', 5)]);
    w.see([machine('l1', 50, { online: false })]);
    w.see([machine('l1', undefined)]);
    expect(w.events).toHaveLength(1);
    w.see([machine('l1', 5)]);
    expect(w.events).toHaveLength(1);
    w.see([machine('l1', 50)]);
    expect(w.events.map((e) => e.type)).toEqual(['machine.disk_low', 'machine.disk_ok']);
  });

  it('reads what the event log told only once', () => {
    let reads = 0;
    const w = createDiskWatch({ told: () => { reads++; return []; }, tell: () => {} });
    w.observe([machine('l1', 50)], at(0));
    w.observe([machine('l1', 5)], at(1));
    expect(reads).toBe(1);
  });
});
