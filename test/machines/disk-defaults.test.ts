// The disk defaults (issue #2494, design.md "Hopper's own disk use" → "Part 13"), pure: what a machine takes from the
// user's defaults where its own options are silent.
import { describe, expect, it } from 'vitest';
import { withDiskDefaults } from '../../src/machines/disk-defaults.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const machine = (over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
  id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['herdr-claude'],
  disk: { freeBytes: 20 * GIB, totalBytes: 100 * GIB, low: false }, ...over,
});

describe('withDiskDefaults', () => {
  it('leaves the machine as it is when there are no defaults', () => {
    const m = machine({ sweep: { pruneAfterDays: 3 } });
    expect(withDiskDefaults(m, undefined)).toEqual(m);
  });

  it('gives a machine with no sweep options the default ones', () => {
    const out = withDiskDefaults(machine(), { sweep: { pruneAfterDays: 7, trimAboveGiB: 20, retainHours: { failed: 48 }, cacheCapsGiB: { npm: 5 } } });
    expect(out.sweep).toEqual({ pruneAfterDays: 7, trimAboveGiB: 20, retainHours: { failed: 48 }, cacheCapsGiB: { npm: 5 } });
  });

  it('keeps each option the machine sets, and takes the default for the rest, each status and each cache kind on its own', () => {
    const m = machine({ sweep: { pruneAfterDays: 2, retainHours: { finished: 1 }, cacheCapsGiB: { go: 10 } } });
    const out = withDiskDefaults(m, { sweep: { pruneAfterDays: 7, everyMinutes: 30, retainHours: { finished: 5, failed: 48 }, cacheCapsGiB: { go: 1, npm: 5 } } });
    expect(out.sweep).toEqual({ pruneAfterDays: 2, everyMinutes: 30, retainHours: { finished: 1, failed: 48 }, cacheCapsGiB: { go: 10, npm: 5 } });
  });

  it('a default dry run applies where the machine sets none; a machine\'s own dryRun false wins (issue #2494 part 14)', () => {
    expect(withDiskDefaults(machine(), { sweep: { dryRun: true } }).sweep).toEqual({ dryRun: true });
    expect(withDiskDefaults(machine({ sweep: { dryRun: false } }), { sweep: { dryRun: true } }).sweep).toEqual({ dryRun: false });
  });

  it('judges the disk again by the default thresholds where the machine sets none', () => {
    // 20 GiB of 100 free: not low by the built-in 5 GiB / 10%, low by a default of 30%.
    const out = withDiskDefaults(machine(), { diskLow: { belowPercent: 30 } });
    expect(out.disk).toEqual({ freeBytes: 20 * GIB, totalBytes: 100 * GIB, low: true });
    expect(withDiskDefaults(machine(), { diskLow: { criticalBelowGiB: 25 } }).disk).toEqual({ freeBytes: 20 * GIB, totalBytes: 100 * GIB, low: true, critical: true });
  });

  it('keeps the machine\'s own thresholds over the defaults', () => {
    const m = machine({ diskThresholds: { belowPercent: 10 } });
    expect(withDiskDefaults(m, { diskLow: { belowPercent: 30 } }).disk?.low).toBe(false);
    expect(withDiskDefaults(m, { diskLow: { belowPercent: 30, belowGiB: 21 } }).disk?.low).toBe(true);
  });

  it('gives a container target nothing: its disk is not the machine\'s and the sweep does not treat it', () => {
    const m = machine({ containerImage: 'debian:bookworm-slim' });
    expect(withDiskDefaults(m, { diskLow: { belowPercent: 30 }, sweep: { pruneAfterDays: 7 } })).toEqual(m);
  });

  it('leaves a machine whose disk was not read with no disk', () => {
    const { disk: _, ...m } = machine();
    expect(withDiskDefaults(m, { diskLow: { belowPercent: 30 } }).disk).toBeUndefined();
  });
});
