// The sweep keeps each machine's last disk measure in the store (issue #2494, design.md "Hopper's own disk use"): after a
// restart, Machines shows it before the first pass measures again, and a machine told over the disk budget is not told again.
import { describe, expect, it } from 'vitest';
import type { DiskMeasure } from '../../src/domain/hopper-disk.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { none, rig } from './sweep-rig.ts';

const found: Survey = {
  ...none, roots: ['/w'], usage: [{ path: '/w/.worktrees', bytes: 3000 }],
  caches: [{ kind: 'npm', path: '/home/u/.npm', bytes: 500 }], storage: [{ runtime: 'podman', kind: 'images', bytes: 900, reclaimableBytes: 100 }],
  jobs: [{ jobId: 'job-1', kind: 'tree', path: '/w/.worktrees/app/job-1', bytes: 2000 }, { jobId: 'job-1', kind: 'scratch', path: '/w/.worktrees/@scratch/job-1', bytes: 600 }],
};

describe('the sweep keeps the last disk measure in the store (issue #2494)', () => {
  it('a pass keeps what it measured, caches, container storage and each job\'s bytes too', async () => {
    const r = rig({ found });
    await r.sweep.run(true);
    const jobs = [{ jobId: 'job-1', bytes: 2600, worktreeBytes: 2000, scratchBytes: 600 }];
    expect(r.measures.get('m')).toEqual({
      at: '2026-10-08T00:00:00.000Z', paths: [{ path: '/w/.worktrees', bytes: 3000 }],
      caches: [{ kind: 'npm', path: '/home/u/.npm', bytes: 500 }], storage: [{ runtime: 'podman', kind: 'images', bytes: 900, reclaimableBytes: 100 }], jobs,
    });
    expect(r.sweep.disk('m')?.jobs).toEqual(jobs);
  });

  it('after a restart, the measure kept shows before any pass, against the budget now', () => {
    const measures = new Map<string, DiskMeasure>([['m', { at: '2026-10-07T00:00:00.000Z', paths: [{ path: '/w/.worktrees', bytes: 3000 }], caches: [{ kind: 'npm', path: '/home/u/.npm', bytes: 500 }] }]]);
    const r = rig({ measures, budget: 1000 });
    expect(r.sweep.disk('m')).toEqual({
      bytes: 3000, at: '2026-10-07T00:00:00.000Z', paths: [{ path: '/w/.worktrees', bytes: 3000 }], budgetBytes: 1000, over: true,
      caches: [{ kind: 'npm', bytes: 500, paths: ['/home/u/.npm'] }],
    });
    expect(r.sweep.disk('other')).toBeUndefined();
  });

  it('a machine told over the budget before the restart, still over: not told again; back within it: told so', async () => {
    const told = [{ type: 'machine.disk_over_budget', machineId: 'm', data: { machineId: 'm', usedBytes: 3000, budgetBytes: 1000, paths: [] } }];
    const r = rig({ found, budget: 1000, told });
    await r.sweep.run(true);
    expect(r.events.filter((e) => e.type === 'machine.disk_over_budget')).toHaveLength(1);
    r.setBudget(5000);
    await r.sweep.run(true);
    expect(r.events.filter((e) => e.type === 'machine.disk_within_budget')).toHaveLength(1);
  });

  it('a machine told back within the budget last: over again is told', async () => {
    const told = [
      { type: 'machine.disk_over_budget', machineId: 'm', data: {} },
      { type: 'machine.disk_within_budget', machineId: 'm', data: {} },
    ];
    const r = rig({ found, budget: 1000, told });
    await r.sweep.run(true);
    expect(r.events.filter((e) => e.type === 'machine.disk_over_budget')).toHaveLength(2);
  });
});
