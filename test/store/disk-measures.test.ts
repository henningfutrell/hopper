// Each machine's last disk measure in the database (issue #2494, tenant migration 94): one row per machine, the newest
// measure replaces the one before, and a store opened again reads it back.
import { describe, expect, it } from 'vitest';
import type { DiskMeasure } from '../../src/domain/hopper-disk.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const measure = (at: string, bytes: number): DiskMeasure => ({
  at, paths: [{ path: '/w/.worktrees', bytes }], caches: [{ kind: 'go', path: '/home/u/go/pkg/mod', bytes: 7 }],
  storage: [{ runtime: 'docker', kind: 'volumes', bytes: 9, reclaimableBytes: 0 }],
});

describe('the disk measures in the database', () => {
  it('keeps the newest measure of each machine, and reads it back after a restart', () => {
    const url = t.url();
    const store = t.open(url);
    store.diskMeasures.keep('m1', measure('2026-10-01T00:00:00.000Z', 1));
    store.diskMeasures.keep('m1', measure('2026-10-02T00:00:00.000Z', 2));
    store.diskMeasures.keep('m2', { at: '2026-10-02T00:00:00.000Z', paths: [] });
    store.close();
    const again = t.open(url);
    expect(new Map(again.diskMeasures.all())).toEqual(new Map([['m1', measure('2026-10-02T00:00:00.000Z', 2)], ['m2', { at: '2026-10-02T00:00:00.000Z', paths: [] }]]));
    again.close();
  });
});
