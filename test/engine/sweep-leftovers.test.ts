// Leftovers (issue #1116): what the layout before issue #1188 left in a work tree's `.hopper-scratch` that the sweep does
// not judge, listed on each machine for a person, who keeps or removes each one. The sweep removes none by itself. Driven
// with the sweep's rig: a fake machine shell, the store's jobs and event trail as plain lists.
import { describe, expect, it } from 'vitest';
import type { Leftover } from '../../src/domain/types.ts';
import { unjudged } from '../../src/domain/leftovers.ts';
import { job, none, rig } from './sweep-rig.ts';

const stranger: Leftover = { path: '/w/.hopper-scratch/other-hopper-job', kind: 'scratch', ageMs: 5 * 86400_000, unpushed: true, bytes: 2e9 };
const mirror: Leftover = { path: '/w/.hopper-scratch/repos/acme/app.git', kind: 'mirror', ageMs: 9 * 86400_000, unpushed: false, users: 1, bytes: 1e9 };
const known: Leftover = { path: '/w/.hopper-scratch/old', kind: 'scratch', ageMs: 86400_000, unpushed: true };
const live: Leftover = { path: '/w/.hopper-scratch/run', kind: 'scratch', ageMs: 60_000, unpushed: true };
const by = { person: 'Pat', via: 'ui' as const };
const found = { ...none, roots: ['/w'] };

describe('the leftovers the sweep does not judge (issue #1116)', () => {
  it('a mirror, and a dir of no job the hopper knows; never a known job\'s dir, ended or live: the sweep reaps those by the reap\'s rule', () => {
    const jobs = new Map([['old', job('old', 'failed')], ['run', job('run', 'running')]]);
    expect(unjudged([known, mirror, live, stranger], (id) => jobs.get(id))).toEqual([stranger, mirror]);
  });
});

describe('the sweep lists them (issue #1116)', () => {
  it('after its reaps, in the work trees the survey found, and keeps the ones it does not judge, with when; it removes none', async () => {
    const r = rig({ found, leftovers: [known, stranger, mirror] });
    await r.sweep.run(true);
    expect(r.listings).toEqual([['/w']]);
    expect(r.sweep.leftovers('m')).toEqual({ at: '2026-10-08T00:00:00.000Z', items: [stranger, mirror] });
    expect(r.removals).toEqual([]);
    expect(r.reaps).toEqual([]);
  });

  it('none listed: no work tree found, nothing it does not judge, or a client older than this', async () => {
    for (const o of [{ found: none, leftovers: [stranger] }, { found, leftovers: [known] }, { found, leftovers: 'old client' as const }]) {
      const r = rig(o);
      await r.sweep.run(true);
      expect(r.sweep.leftovers('m')).toBeUndefined();
    }
  });

  it('a listing that fails keeps the last one, and is told once while it fails', async () => {
    const r = rig({ found, leftovers: 'fails' });
    await r.sweep.run(true);
    await r.sweep.run(true);
    expect(r.sweep.leftovers('m')).toBeUndefined();
    expect(r.logs.filter((l) => l.includes('could not list the leftovers'))).toHaveLength(1);
  });
});

describe('a person decides on each one (issue #1116)', () => {
  it('keep: recorded as machine.leftover_kept with who, nothing removed, and the listing shows it kept', async () => {
    const r = rig({ found, leftovers: [stranger, mirror] });
    await r.sweep.run(true);
    expect(await r.sweep.decideLeftover('m', stranger.path, 'keep', by)).toEqual({ machineId: 'm', path: stranger.path, decision: 'keep' });
    expect(r.removals).toEqual([]);
    expect(r.events.at(-1)).toEqual({ type: 'machine.leftover_kept', machineId: 'm', data: { machineId: 'm', path: stranger.path, person: 'Pat', via: 'ui' } });
    const items = r.sweep.leftovers('m')!.items;
    expect(items[0]!.kept).toMatchObject({ person: 'Pat', via: 'ui' });
    expect(items[1]!.kept).toBeUndefined();
  });

  it('remove: removed on its machine whatever it holds, recorded as machine.leftover_removed with what it held, and gone from the listing', async () => {
    const r = rig({ found, leftovers: [stranger, mirror] });
    await r.sweep.run(true);
    await r.sweep.decideLeftover('m', stranger.path, 'remove', by);
    expect(r.removals).toEqual([stranger.path]);
    expect(r.events.at(-1)).toEqual({ type: 'machine.leftover_removed', machineId: 'm', data: { machineId: 'm', path: stranger.path, unpushed: true, bytes: 2e9, person: 'Pat', via: 'ui' } });
    expect(r.sweep.leftovers('m')!.items).toEqual([mirror]);
  });

  it('a leftover no longer there is recorded gone; one still there after the removal is refused, and stays listed', async () => {
    const gone = rig({ found, leftovers: [mirror], removal: 'gone' });
    await gone.sweep.run(true);
    await gone.sweep.decideLeftover('m', mirror.path, 'remove', by);
    expect(gone.events.at(-1)?.data).toMatchObject({ gone: true });
    expect(gone.sweep.leftovers('m')).toBeUndefined();
    const left = rig({ found, leftovers: [mirror], removal: 'left' });
    await left.sweep.run(true);
    await expect(left.sweep.decideLeftover('m', mirror.path, 'remove', by)).rejects.toThrow(/still there/);
    expect(left.events.some((e) => e.type === 'machine.leftover_removed')).toBe(false);
    expect(left.sweep.leftovers('m')!.items).toEqual([mirror]);
  });

  it('only a leftover the sweep listed on that machine: any other path is refused, and nothing is removed', async () => {
    const r = rig({ found, leftovers: [stranger] });
    await r.sweep.run(true);
    await expect(r.sweep.decideLeftover('m', known.path, 'remove', by)).rejects.toThrow(/no leftover the sweep listed/);
    await expect(r.sweep.decideLeftover('m', '/home', 'remove', by)).rejects.toThrow(/no leftover the sweep listed/);
    await expect(r.sweep.decideLeftover('elsewhere', stranger.path, 'remove', by)).rejects.toThrow(/not found/);
    expect(r.removals).toEqual([]);
  });

  it('a machine offline is not swept, so none is listed there, and a removal is refused', async () => {
    const m = { id: 'm', label: 'm', maxLanes: 1, online: false, executors: ['x'] };
    const off = rig({ found, leftovers: [stranger], machines: [m] });
    await off.sweep.run(true);
    expect(off.sweep.leftovers('m')).toBeUndefined();
    await expect(off.sweep.decideLeftover('m', stranger.path, 'remove', by)).rejects.toThrow();
    expect(off.removals).toEqual([]);
  });
});
