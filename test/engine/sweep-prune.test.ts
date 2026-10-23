// The storage prune in the sweep (issue #2494, design.md "Hopper's own disk use" → "Part 8"): on a machine with
// `pruneAfterDays`, a pass prunes its container storage once a day, at once while its disk is low (then once an hour), and
// records what it removed as one machine.storage_pruned event with the bytes. Off by default.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
const DAY = 24 * HOUR;
const OLD = 'a'.repeat(64), RECENT = 'b'.repeat(64);
// The rig's clock is 2026-10-08: OLD stopped 40 days before, RECENT 2 days before.
const found: Survey = { ...none, exited: [
  { runtime: 'podman', id: OLD, finishedAt: '2026-08-29T00:00:00Z', labels: [] },
  { runtime: 'docker', id: RECENT, finishedAt: '2026-10-06T00:00:00Z', labels: [] },
] };
const machine = (o: { days?: number; low?: boolean } = {}): MachineSnapshot => ({
  id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'],
  ...(o.days !== undefined ? { sweep: { pruneAfterDays: o.days } } : {}),
  ...(o.low !== undefined ? { disk: { freeBytes: (o.low ? 2 : 50) * GIB, totalBytes: 100 * GIB, low: o.low } } : {}),
});
const removed = [
  { runtime: 'podman' as const, kind: 'container' as const, id: OLD, bytes: 4096 },
  { runtime: 'podman' as const, kind: 'volume' as const, id: 'c'.repeat(64) },
  { runtime: 'podman' as const, kind: 'image' as const, id: 'd'.repeat(64), bytes: 1.5e9 },
];

describe('the storage prune in the sweep (issue #2494)', () => {
  it('is off unless the machine sets pruneAfterDays', async () => {
    const r = rig({ found, machines: [machine()] });
    await r.sweep.run(true);
    expect(r.prunes).toEqual([]);
  });

  it('prunes with the machine\'s age and the exited containers older than it, and records what it removed with the bytes', async () => {
    const r = rig({ found, machines: [machine({ days: 30 })], pruned: { removed } });
    await r.sweep.run(true);
    expect(r.prunes).toEqual([{ days: 30, containers: [`podman:${OLD}`] }]);
    expect(r.events.filter((e) => e.type === 'machine.storage_pruned')).toEqual([
      { type: 'machine.storage_pruned', machineId: 'm', data: { machineId: 'm', olderThanDays: 30, bytes: 4096 + 1.5e9, removed } },
    ]);
    expect(r.logs.some((l) => /pruned 1 container, 1 volume and 1 image on m, 1\.5 GB/.test(l))).toBe(true);
  });

  it('prunes once a day, not at each pass', async () => {
    const r = rig({ found, machines: [machine({ days: 30 })] });
    await r.sweep.run(true);
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.prunes).toHaveLength(1);
    r.advance(DAY);
    await r.sweep.run(true);
    expect(r.prunes).toHaveLength(2);
  });

  it('prunes again after an hour while the disk is low', async () => {
    const r = rig({ found, machines: [machine({ days: 30, low: true })] });
    await r.sweep.run(true);
    r.advance(HOUR / 2);
    await r.sweep.run(true);
    expect(r.prunes).toHaveLength(1);
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.prunes).toHaveLength(2);
  });

  it('records nothing when it removed nothing', async () => {
    const r = rig({ found, machines: [machine({ days: 30 })] });
    await r.sweep.run(true);
    expect(r.events.filter((e) => e.type === 'machine.storage_pruned')).toEqual([]);
  });

  it('a client older than the prune: said once, and the pass goes on', async () => {
    const r = rig({ found, machines: [machine({ days: 30 })], pruned: 'old client' });
    await r.sweep.run(true);
    r.advance(DAY);
    await r.sweep.run(true);
    expect(r.prunes).toHaveLength(2);
    expect(r.logs.filter((l) => /could not prune the container storage on m/.test(l))).toHaveLength(1);
    expect(r.surveyed).toHaveLength(2);
  });
});
