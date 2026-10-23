// The sweep's dry run and the disk budget of each machine (issue #2494, design.md "Hopper's own disk use" → "Part 14"), pure.
import { describe, expect, it } from 'vitest';
import { budgetOf, dryRunOf } from '../../src/domain/sweep-dry-run.ts';
import type { Survey } from '../../src/domain/ports.ts';

const GIB = 1024 ** 3;
const OLD = 'a'.repeat(64);
const found: Survey = {
  scopes: [], processes: [], scratch: [],
  jobs: [
    { jobId: 'done', kind: 'scratch', path: '/w/.worktrees/@scratch/done', bytes: 2 * GIB }, { jobId: 'done', kind: 'tree', path: '/w/.worktrees/hopper/done', bytes: GIB },
    { jobId: 'kept', kind: 'scratch', path: '/w/.worktrees/@scratch/kept', bytes: 5 * GIB },
  ],
  caches: [{ kind: 'npm', path: '/h/.npm', bytes: 3 * GIB }, { kind: 'gradle', path: '/h/.gradle/caches', bytes: GIB }],
  storage: [
    { runtime: 'podman', kind: 'images', bytes: 9 * GIB, reclaimableBytes: 4 * GIB }, { runtime: 'podman', kind: 'volumes', bytes: GIB, reclaimableBytes: GIB },
    { runtime: 'podman', kind: 'build-cache', bytes: GIB, reclaimableBytes: GIB },
  ],
  exited: [{ runtime: 'podman', id: OLD, finishedAt: '2026-08-29T00:00:00Z', labels: [] }],
};
const plan = [{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }, { jobId: 'kept', scratch: '/w/.worktrees/@scratch/kept' }, { jobId: 'gone' }];
const now = Date.parse('2026-10-08T00:00:00Z');

describe('the disk budget of a machine (issue #2494)', () => {
  it('is its own diskBudgetGiB, else the user\'s disk budget, else none', () => {
    expect(budgetOf({ budgetGiB: 4 }, { bytes: 10 * GIB })).toEqual({ bytes: 4 * GIB });
    expect(budgetOf({ budgetGiB: 4 }, undefined)).toEqual({ bytes: 4 * GIB });
    expect(budgetOf({}, { bytes: 10 * GIB })).toEqual({ bytes: 10 * GIB });
    expect(budgetOf(undefined, undefined)).toBeUndefined();
  });
});

describe('the sweep\'s dry run (issue #2494)', () => {
  it('lists the reaps with each job\'s bytes, the work kept before apart; the stops; the prune, the caches and the trim it would run', () => {
    const d = dryRunOf({ id: 'm', sweep: { dryRun: true, pruneAfterDays: 30, cacheCapsGiB: { npm: 2, gradle: 2 }, trimAboveGiB: 5 } }, found, plan, new Set(['kept']), now);
    expect(d).toEqual({
      machineId: 'm',
      reaps: [{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done', bytes: 3 * GIB }, { jobId: 'kept', scratch: '/w/.worktrees/@scratch/kept', bytes: 5 * GIB, kept: true }],
      reapBytes: 3 * GIB, stops: ['gone'],
      prune: { olderThanDays: 30, containers: [`podman:${OLD}`], reclaimableBytes: 5 * GIB },
      caches: [{ kind: 'npm', path: '/h/.npm', bytes: 3 * GIB }], cacheBytes: 3 * GIB,
      trim: { aboveGiB: 5, due: true },
    });
  });

  it('names no prune, cache or trim the machine does not set, and no bytes the survey did not measure', () => {
    const d = dryRunOf({ id: 'm', sweep: { dryRun: true } }, { scopes: [], processes: [], scratch: [] }, plan.slice(0, 1), new Set(), now);
    expect(d).toEqual({ machineId: 'm', reaps: [{ jobId: 'done', scratch: '/w/.worktrees/@scratch/done' }], reapBytes: 0, stops: [], cacheBytes: 0 });
  });

  it('while the disk is low, lists every capped kind that takes anything; the trim is not due below its threshold', () => {
    const d = dryRunOf({ id: 'm', sweep: { dryRun: true, cacheCapsGiB: { npm: 10, gradle: 10 }, trimAboveGiB: 50 }, disk: { freeBytes: GIB, totalBytes: 100 * GIB, low: true } }, found, [], new Set(), now);
    expect(d.caches?.map((c) => c.kind)).toEqual(['npm', 'gradle']);
    expect(d.trim).toEqual({ aboveGiB: 50, due: false });
  });
});
