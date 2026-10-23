// The cleanup pass's record (issue #2494, design.md "Hopper's own disk use" → "Part 15"): each real pass of the sweep on a
// machine that removed something, kept work for the first time, could not remove a dir, or trimmed records one
// machine.sweep_passed event: what it removed by kind, with the count and the bytes; what it kept and why; and the fstrim
// result. A pass that did none of these, and a dry run, record none.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
const machine = (sweep?: MachineSnapshot['sweep']): MachineSnapshot => ({ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'], ...(sweep ? { sweep } : {}) });
const SCRATCH = '/w/.worktrees/@scratch/done';
// `done` ended 25 hours ago: its scratch dir goes at this pass; the survey measured 2 GiB of it and its worktree.
const found: Survey = {
  ...none, roots: ['/w'], scratch: [{ jobId: 'done', path: SCRATCH, ageMs: 25 * HOUR }],
  jobs: [{ jobId: 'done', kind: 'scratch', path: SCRATCH, bytes: GIB }, { jobId: 'done', kind: 'tree', path: '/w/.worktrees/app/done', bytes: GIB }],
};
const passed = (r: ReturnType<typeof rig>) => r.passes;

describe('the cleanup pass\'s record (issue #2494)', () => {
  it('records what the reaps removed, by kind, with the count and the bytes', async () => {
    const r = rig({ found });
    await r.sweep.run(true);
    expect(passed(r)).toEqual([{ type: 'machine.sweep_passed', machineId: 'm', data: { machineId: 'm', removed: [{ kind: 'scratch', count: 1, bytes: 2 * GIB }], freedBytes: 2 * GIB, kept: [] } }]);
  });

  it('records the containers and volumes a reap removed of a job, with no bytes', async () => {
    const r = rig({ found: { ...none, containers: ['old'] }, containers: ['old'] });
    await r.sweep.run(true);
    expect(passed(r)[0]!.data).toEqual({ machineId: 'm', removed: [{ kind: 'job-storage', count: 2 }], freedBytes: 0, kept: [] });
  });

  it('records work kept for the first time with why; kept again, the next pass records nothing', async () => {
    const r = rig({ found, keeps: ['done'], reasons: ['done'] });
    await r.sweep.run(true);
    expect(passed(r)[0]!.data).toEqual({ machineId: 'm', removed: [], freedBytes: 0, kept: [{ jobId: 'done', paths: [`${SCRATCH}/repo`], reasons: { [`${SCRATCH}/repo`]: ['unpushed'] } }] });
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(passed(r)).toHaveLength(1);
  });

  it('lists the work kept again beside a removal', async () => {
    const r = rig({ found: { ...found, scratch: [...found.scratch, { jobId: 'old', path: '/w/.worktrees/@scratch/old', ageMs: 25 * HOUR }] }, keeps: ['old'], kept: ['old'] });
    await r.sweep.run(true);
    expect(passed(r)[0]!.data).toMatchObject({ removed: [{ kind: 'scratch', count: 1 }], kept: [{ jobId: 'old', paths: ['/w/.worktrees/@scratch/old/repo'], again: true }] });
  });

  it('records a dir the reap could not remove, once', async () => {
    const r = rig({ found, lefts: ['done'] });
    await r.sweep.run(true);
    expect(passed(r)[0]!.data).toEqual({ machineId: 'm', removed: [], freedBytes: 0, kept: [], left: [{ jobId: 'done', paths: [SCRATCH] }] });
    r.advance(HOUR);
    await r.sweep.run(true);
    expect(passed(r)).toHaveLength(1);
  });

  it('records the storage prune, the caches cleared and the fstrim result of the pass', async () => {
    const OLD = 'a'.repeat(64);
    const pruned = { removed: [{ runtime: 'podman' as const, kind: 'container' as const, id: OLD, bytes: GIB }, { runtime: 'podman' as const, kind: 'image' as const, id: 'd'.repeat(64), bytes: 2 * GIB }] };
    const r = rig({
      found: { ...none, exited: [{ runtime: 'podman', id: OLD, finishedAt: '2026-08-29T00:00:00Z', labels: [] }], caches: [{ kind: 'npm', path: '/h/.npm', bytes: 3 * GIB }] },
      machines: [{ ...machine({ pruneAfterDays: 30, cacheCapsGiB: { npm: 1 }, trimAboveGiB: 2 }), id: 'n', label: 'n' }],
      pruned, trimmed: { mount: '/', outcome: 'trimmed', bytes: 9 * GIB, wsl: true },
    });
    await r.sweep.run(true);
    expect(passed(r)[0]).toMatchObject({
      machineId: 'n', data: {
        machineId: 'n', freedBytes: 6 * GIB, kept: [],
        removed: [{ kind: 'storage', count: 2, bytes: 3 * GIB }, { kind: 'caches', count: 1, bytes: 3 * GIB }],
        trim: { mount: '/', outcome: 'trimmed', trimmedBytes: 9 * GIB, hostCompaction: true },
      },
    });
  });

  it('records nothing for a pass that did nothing, nor for a dry run', async () => {
    const idle = rig({ found: none });
    await idle.sweep.run(true);
    expect(passed(idle)).toEqual([]);
    const dry = rig({ found, machines: [machine({ dryRun: true })] });
    await dry.sweep.run(true);
    expect(passed(dry)).toEqual([]);
  });
});
