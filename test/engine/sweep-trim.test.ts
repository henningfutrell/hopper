// The trim in the sweep (issue #2494, design.md "Hopper's own disk use" → "Part 9"): on a machine with `trimAboveGiB`,
// the sweep adds up what its passes freed there — the storage prune's bytes, and the drop of the hopper's own disk use
// after its reaps —, and once the sum reaches the option it runs fstrim there and records the result as one
// machine.disk_trim_ran event. Off by default.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
const machine = (sweep: MachineSnapshot['sweep']): MachineSnapshot => ({ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'], ...(sweep ? { sweep } : {}) });
// `done` ended 25 hours ago: its scratch dir goes at this pass. `used` GiB of the hopper's own disk use before it.
const before = (used: number): Survey => ({ ...none, roots: ['/w'], scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: 25 * HOUR }], usage: [{ path: '/w/.worktrees', bytes: used * GIB }] });
const after = (used: number): Survey => ({ ...none, roots: ['/w'], usage: [{ path: '/w/.worktrees', bytes: used * GIB }] });
const OLD = 'a'.repeat(64);
const prunedSurvey: Survey = { ...none, exited: [{ runtime: 'podman', id: OLD, finishedAt: '2026-08-29T00:00:00Z', labels: [] }] };
const ran = (r: ReturnType<typeof rig>) => r.events.filter((e) => e.type === 'machine.disk_trim_ran');

describe('the trim in the sweep (issue #2494)', () => {
  it('is off unless the machine sets trimAboveGiB', async () => {
    const r = rig({ surveys: [before(5), after(1)], machines: [machine(undefined)] });
    await r.sweep.run(true);
    expect(r.trims()).toBe(0);
    expect(r.surveyed).toHaveLength(1);
  });

  it('measures again after its reaps, and trims once what they freed reaches the option; the result is recorded', async () => {
    const r = rig({ surveys: [before(5), after(2)], machines: [machine({ trimAboveGiB: 2 })], trimmed: { mount: '/', outcome: 'trimmed', bytes: 4 * GIB } });
    await r.sweep.run(true);
    expect(r.surveyed).toHaveLength(2);
    expect(r.trims()).toBe(1);
    expect(ran(r)).toEqual([{ type: 'machine.disk_trim_ran', machineId: 'm', data: { machineId: 'm', freedBytes: 3 * GIB, mount: '/', outcome: 'trimmed', trimmedBytes: 4 * GIB } }]);
    expect(r.logs.some((l) => /ran fstrim on m \(\/\): 4\.3 GB trimmed/.test(l))).toBe(true);
  });

  it('adds up what each pass freed, and starts again from nothing after a trim', async () => {
    const r = rig({ surveys: [before(5), after(4), before(4), after(3), before(3), after(2)], machines: [machine({ trimAboveGiB: 2 })] });
    await r.sweep.run(true);
    expect(r.trims()).toBe(0);
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.trims()).toBe(1);
    expect(ran(r)[0]!.data).toMatchObject({ freedBytes: 2 * GIB });
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.trims()).toBe(1);
  });

  it('counts the bytes the storage prune removed', async () => {
    const removed = [{ runtime: 'podman' as const, kind: 'image' as const, id: 'd'.repeat(64), bytes: 3 * GIB }];
    const r = rig({ found: prunedSurvey, machines: [machine({ pruneAfterDays: 30, trimAboveGiB: 2 })], pruned: { removed } });
    await r.sweep.run(true);
    expect(r.trims()).toBe(1);
    expect(ran(r)[0]!.data).toMatchObject({ freedBytes: 3 * GIB });
  });

  it('on WSL, says that the host\'s virtual disk shrinks only by a compaction there', async () => {
    const r = rig({ surveys: [before(5), after(1)], machines: [machine({ trimAboveGiB: 2 })], trimmed: { mount: '/', outcome: 'trimmed', bytes: GIB, wsl: true } });
    await r.sweep.run(true);
    expect(ran(r)[0]!.data).toMatchObject({ hostCompaction: true });
    expect(r.logs.some((l) => /compact/.test(l))).toBe(true);
  });

  it('a trim the machine refuses is recorded with what it said', async () => {
    const r = rig({ surveys: [before(5), after(1)], machines: [machine({ trimAboveGiB: 2 })], trimmed: { mount: '/', outcome: 'refused', said: 'fstrim: /: FITRIM ioctl failed: Operation not permitted' } });
    await r.sweep.run(true);
    expect(ran(r)).toEqual([{ type: 'machine.disk_trim_ran', machineId: 'm', data: { machineId: 'm', freedBytes: 4 * GIB, mount: '/', outcome: 'refused', said: 'fstrim: /: FITRIM ioctl failed: Operation not permitted' } }]);
  });

  it('a client older than the trim: said once, nothing recorded, and the pass goes on', async () => {
    const r = rig({ surveys: [before(5), after(1), before(5), after(1)], machines: [machine({ trimAboveGiB: 2 })], trimmed: 'old client' });
    await r.sweep.run(true);
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(r.trims()).toBe(2);
    expect(ran(r)).toEqual([]);
    expect(r.logs.filter((l) => /could not run fstrim on m/.test(l))).toHaveLength(1);
  });
});
