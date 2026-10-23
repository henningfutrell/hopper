// The cache caps in the sweep (issue #2494, design.md "Hopper's own disk use" → "Part 10"): on a machine with a cap for a
// kind of cache, the sweep empties that kind once the survey finds it over its cap — every capped kind at once while the
// disk is low —, only while no job there may use it, at most once an hour, and records what it removed as one
// machine.caches_cleared event. Off by default. The rig's job `run` runs on machine `m`; machine `n` has no job.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, job, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
const machine = (id: string, sweep: MachineSnapshot['sweep'], low = false): MachineSnapshot => ({
  id, label: id, maxLanes: 1, online: true, executors: ['x'], ...(sweep ? { sweep } : {}),
  ...(low ? { disk: { freeBytes: GIB, totalBytes: 100 * GIB, low: true } } : {}),
});
const found: Survey = {
  ...none, caches: [
    { kind: 'gradle', path: '/h/.gradle/caches', bytes: 9 * GIB }, { kind: 'gradle', path: '/h/.gradle/wrapper/dists', bytes: 3 * GIB },
    { kind: 'npm', path: '/h/.npm', bytes: GIB }, { kind: 'cache', path: '/h/.cache', bytes: 20 * GIB },
  ],
};
const cleared = (r: ReturnType<typeof rig>) => r.events.filter((e) => e.type === 'machine.caches_cleared');

describe('the cache caps in the sweep (issue #2494)', () => {
  it('is off unless the machine sets a cap', async () => {
    const r = rig({ found, machines: [machine('n', undefined)] });
    await r.sweep.run(true);
    expect(r.clears).toEqual([]);
  });

  it('empties each kind over its cap, and records what it removed with the bytes', async () => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 10, npm: 5 } })] });
    await r.sweep.run(true);
    expect(r.clears).toEqual([['gradle']]);
    expect(cleared(r)).toEqual([{
      type: 'machine.caches_cleared', machineId: 'n',
      data: { machineId: 'n', bytes: 12 * GIB, removed: [{ kind: 'gradle', path: '/h/.gradle/caches', bytes: 9 * GIB }, { kind: 'gradle', path: '/h/.gradle/wrapper/dists', bytes: 3 * GIB }] },
    }]);
  });

  it('never clears while a job there is running, and says so once', async () => {
    const r = rig({ found, machines: [machine('m', { cacheCapsGiB: { gradle: 10 } })] });
    await r.sweep.run(true);
    r.advance(2 * HOUR);
    await r.sweep.run(true);
    expect(r.clears).toEqual([]);
    expect(r.logs.filter((l) => /leaves the gradle caches on m over their cap for now: job run is running there/.test(l))).toHaveLength(1);
  });

  it.each(['parked', 'waiting_on', 'waiting_answer', 'claimed', 'operator_led', 'queued'] as const)('never clears while a job there is %s', async (status) => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 10 } })], others: [{ ...job('j', status), spec: { executor: 'x', payload: {}, machineId: 'n' } }] });
    await r.sweep.run(true);
    expect(r.clears).toEqual([]);
  });

  it('never clears while the survey finds a job\'s scope or process there', async () => {
    const r = rig({ found: { ...found, processes: ['other-hoppers-job'] }, machines: [machine('n', { cacheCapsGiB: { gradle: 10 } })] });
    await r.sweep.run(true);
    expect(r.clears).toEqual([]);
  });

  it('while the disk is low, empties every kind with a cap, under it too', async () => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 100, npm: 5, pip: 1 } }, true)] });
    await r.sweep.run(true);
    expect(r.clears).toEqual([['gradle', 'npm']]);
    expect(cleared(r)[0]!.data).toMatchObject({ bytes: 13 * GIB, low: true });
  });

  it('clears at most once an hour on a machine', async () => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 10 } })] });
    await r.sweep.run(true);
    r.advance(HOUR / 2);
    await r.sweep.run(true);
    expect(r.clears).toHaveLength(1);
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.clears).toHaveLength(2);
  });

  it('a client older than the clear: said once, nothing recorded', async () => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 10 } })], cleared: () => 'old client' });
    await r.sweep.run(true);
    r.advance(2 * HOUR);
    await r.sweep.run(true);
    expect(r.clears).toHaveLength(2);
    expect(cleared(r)).toEqual([]);
    expect(r.logs.filter((l) => /could not clear the caches on n/.test(l))).toHaveLength(1);
  });

  it('what it freed counts toward the trim', async () => {
    const r = rig({ found, machines: [machine('n', { cacheCapsGiB: { gradle: 10 }, trimAboveGiB: 10 })] });
    await r.sweep.run(true);
    expect(r.trims()).toBe(1);
    expect(r.events.find((e) => e.type === 'machine.disk_trim_ran')!.data).toMatchObject({ freedBytes: 12 * GIB });
  });
});
