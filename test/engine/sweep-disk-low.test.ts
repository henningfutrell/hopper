// The sweep on a machine whose disk is low (issue #2490, design.md "A machine's disk"): the low disk takes no new job,
// and the sweep frees what it may there: at once when the disk turns low, and every ended job's scratch dir whatever its age.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
// `done` ended an hour ago: not yet old enough for its scratch dir to go by age.
const young: Survey = { ...none, scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: 1 * HOUR }], roots: ['/w'] };
const machine = (low: boolean): MachineSnapshot => ({ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'], disk: { freeBytes: (low ? 2 : 50) * GIB, totalBytes: 100 * GIB, low } });

describe('the sweep on a machine whose disk is low (issue #2490)', () => {
  it('reaps every ended job\'s scratch dir now, whatever its age, and says why', async () => {
    const r = rig({ found: young, machines: [machine(true)] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }]);
    expect(r.logs.some((l) => /disk low on m \(2\.1 GB free\): the sweep reaps every ended job's scratch dir now/.test(l))).toBe(true);
  });

  it('a disk that is not low: nothing is reaped before its age', async () => {
    const r = rig({ found: young, machines: [machine(false)] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([]);
  });

  it('a disk that turns low is swept at once, not after its interval; then by its interval while it stays low', async () => {
    const machines = [machine(false)];
    const r = rig({ found: young, machines });
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(1);
    r.advance(60_000);
    machines[0] = machine(true);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(2);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }]);
    r.advance(60_000);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(2);
    r.advance(10 * 60_000);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(3);
  });

  it('low again after it was not: swept at once again', async () => {
    const machines = [machine(true)];
    const r = rig({ found: young, machines });
    await r.sweep.run();
    r.advance(60_000);
    machines[0] = machine(false);
    await r.sweep.run();
    r.advance(60_000);
    machines[0] = machine(true);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(2);
  });
});
