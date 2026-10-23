// The sweep's dry run and the disk budget of each machine (issue #2494, design.md "Hopper's own disk use" → "Part 14"): on
// a machine with `sweepDryRun`, a pass reaps, prunes, clears and trims nothing; it records what it would remove as one
// machine.sweep_dry_run event, and again only once that changes. A machine's `diskBudgetGiB` is its budget, in place of
// the user's. The rig's job `run` runs on machine `m`; machine `n` has no job.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const GIB = 1024 ** 3;
const machine = (id: string, sweep: MachineSnapshot['sweep']): MachineSnapshot => ({ id, label: id, maxLanes: 1, online: true, executors: ['x'], ...(sweep ? { sweep } : {}) });
// `done` ended 30 hours ago: old enough for its scratch dir to go by age.
const found: Survey = {
  ...none, roots: ['/w'], scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: 30 * HOUR }],
  jobs: [{ jobId: 'done', kind: 'scratch', path: '/w/.worktrees/@scratch/done', bytes: 2 * GIB }],
  caches: [{ kind: 'npm', path: '/h/.npm', bytes: 3 * GIB }],
  exited: [{ runtime: 'podman', id: 'a'.repeat(64), finishedAt: '2026-08-29T00:00:00Z', labels: [] }],
};
const all = { dryRun: true, pruneAfterDays: 30, cacheCapsGiB: { npm: 1 }, trimAboveGiB: 1 };
const told = (r: ReturnType<typeof rig>) => r.events.filter((e) => e.type === 'machine.sweep_dry_run');

describe('the sweep\'s dry run (issue #2494)', () => {
  it('reaps, prunes, clears and trims nothing, and records what it would remove', async () => {
    const r = rig({ found, machines: [machine('n', all)] });
    await r.sweep.run(true);
    expect([r.reaps, r.prunes, r.clears, r.trims()]).toEqual([[], [], [], 0]);
    expect(told(r)).toEqual([{
      type: 'machine.sweep_dry_run', machineId: 'n',
      data: {
        machineId: 'n', reaps: [{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done', bytes: 2 * GIB }], reapBytes: 2 * GIB, stops: [],
        prune: { olderThanDays: 30, containers: [`podman:${'a'.repeat(64)}`], reclaimableBytes: 0 },
        caches: [{ kind: 'npm', path: '/h/.npm', bytes: 3 * GIB }], cacheBytes: 3 * GIB, trim: { aboveGiB: 1, due: true },
      },
    }]);
    expect(r.sweep.disk('n')).toBeUndefined();
  });

  it('records it again only once what it would remove changes', async () => {
    const r = rig({ surveys: [found, found, { ...found, scratch: [], jobs: [] }], machines: [machine('n', all)] });
    await r.sweep.run(true);
    await r.sweep.run(true);
    expect(told(r)).toHaveLength(1);
    await r.sweep.run(true);
    expect(told(r)).toHaveLength(2);
    expect(told(r)[1]!.data).toMatchObject({ reaps: [], reapBytes: 0 });
  });

  it('a machine with no dry run records none', async () => {
    const r = rig({ found, machines: [machine('n', { pruneAfterDays: 30 })] });
    await r.sweep.run(true);
    expect(told(r)).toEqual([]);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }]);
  });
});

describe('the disk budget of each machine (issue #2494)', () => {
  const usage = [{ path: '/w/.worktrees/@scratch', bytes: 5 * GIB }];
  const young: Survey = { ...none, roots: ['/w'], scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: HOUR }], usage };

  it('a machine\'s diskBudgetGiB wins over the user\'s disk budget', async () => {
    const r = rig({ budget: 10 * GIB, found: young, machines: [machine('m', { budgetGiB: 4 })] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }]);
    expect(r.events.filter((e) => e.type === 'machine.disk_over_budget')).toEqual([
      { type: 'machine.disk_over_budget', machineId: 'm', data: { machineId: 'm', usedBytes: 5 * GIB, budgetBytes: 4 * GIB, paths: usage } },
    ]);
    expect(r.sweep.disk('m', { budgetGiB: 4 })).toMatchObject({ budgetBytes: 4 * GIB, over: true });
    expect(r.sweep.disk('m')).toMatchObject({ budgetBytes: 10 * GIB, over: false });
  });

  it('with no budget of the user\'s, a machine\'s own still holds', async () => {
    const r = rig({ found: young, machines: [machine('m', { budgetGiB: 6 })] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([]);
    expect(r.sweep.disk('m', { budgetGiB: 6 })).toMatchObject({ budgetBytes: 6 * GIB, over: false });
  });
});
