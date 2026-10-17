// The offline watch (issue #1497): a machine offline for two minutes is told once (machine.offline), and once more when
// it is online again (machine.back_online). A container a host restart left stopped is told so. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createOfflineWatch, type OfflineEvent } from '../../src/machines/offline-watch.ts';

const at = (min: number) => new Date(Date.parse('2026-10-16T22:30:00.000Z') + min * 60_000).toISOString();
const machine = (id: string, online: boolean): MachineSnapshot => ({ id, label: `seat ${id}`, online }) as unknown as MachineSnapshot;

function watch() {
  const told: OfflineEvent[] = [];
  const w = createOfflineWatch({ tell: (e) => told.push(e) });
  return { told, see: (ms: MachineSnapshot[], min: number) => w.observe(ms, at(min)) };
}

describe('the offline watch', () => {
  it('offline for two minutes is told once; online again is told once', () => {
    const w = watch();
    w.see([machine('l1', true)], 0);
    w.see([machine('l1', false)], 1);
    w.see([machine('l1', false)], 2);
    expect(w.told).toEqual([]);
    w.see([machine('l1', false)], 3);
    w.see([machine('l1', false)], 4);
    expect(w.told).toEqual([{ type: 'machine.offline', machineId: 'l1', data: { machineId: 'l1', label: 'seat l1', since: at(1) } }]);
    w.see([machine('l1', true)], 5);
    w.see([machine('l1', true)], 6);
    expect(w.told.map((e) => e.type)).toEqual(['machine.offline', 'machine.back_online']);
    expect(w.told[1]).toEqual({ type: 'machine.back_online', machineId: 'l1', data: { machineId: 'l1', label: 'seat l1', since: at(1) } });
  });

  it('a short stretch offline is not told, and back online after it tells nothing', () => {
    const w = watch();
    w.see([machine('l1', false)], 0);
    w.see([machine('l1', false)], 1);
    w.see([machine('l1', true)], 2);
    w.see([machine('l1', false)], 3);
    w.see([machine('l1', false)], 4);
    expect(w.told).toEqual([]);
  });

  it('after a restart of the hopper, each machine still offline is told, apart', () => {
    const w = watch();
    const seats = (online: boolean) => ['l1', 'l2', 'l3', 'l4'].map((id) => machine(id, online));
    w.see([machine('local', true), ...seats(false)], 0);
    w.see([machine('local', true), ...seats(false)], 2);
    expect(w.told.map((e) => `${e.machineId} ${e.type}`)).toEqual(['l1 machine.offline', 'l2 machine.offline', 'l3 machine.offline', 'l4 machine.offline']);
  });

  it('a machine gone from the list is forgotten: back in the list, it starts again', () => {
    const w = watch();
    w.see([machine('l1', false)], 0);
    w.see([machine('l1', false)], 2);
    w.see([], 3);
    w.see([machine('l1', true)], 4);
    w.see([machine('l1', false)], 5);
    w.see([machine('l1', false)], 6);
    expect(w.told.map((e) => e.type)).toEqual(['machine.offline']);
  });
});
