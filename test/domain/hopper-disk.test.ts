// The caches and container storage on a machine, as the hopper keeps them from the sweep's survey (issue #2494): pure.
import { describe, expect, it } from 'vitest';
import { cacheUseOf, hopperDiskOf } from '../../src/domain/hopper-disk.ts';

const at = '2026-10-22T10:00:00.000Z';

describe('cacheUseOf', () => {
  it('sums each kind\'s places, biggest first, and counts in the rest of ~/.cache only what no other kind holds', () => {
    expect(cacheUseOf([
      { kind: 'gradle', path: '/h/.gradle/caches', bytes: 300 },
      { kind: 'gradle', path: '/h/.gradle/wrapper/dists', bytes: 100 },
      { kind: 'pip', path: '/h/.cache/pip', bytes: 50 },
      { kind: 'cache', path: '/h/.cache', bytes: 250 },
      { kind: 'npm', path: '/h/.npm', bytes: 70 },
    ])).toEqual([
      { kind: 'gradle', bytes: 400, paths: ['/h/.gradle/caches', '/h/.gradle/wrapper/dists'] },
      { kind: 'cache', bytes: 200, paths: ['/h/.cache'] },
      { kind: 'npm', bytes: 70, paths: ['/h/.npm'] },
      { kind: 'pip', bytes: 50, paths: ['/h/.cache/pip'] },
    ]);
  });

  it('never counts the rest below nothing, when a measure inside it was cut off apart', () => {
    expect(cacheUseOf([{ kind: 'pip', path: '/h/.cache/pip', bytes: 80 }, { kind: 'cache', path: '/h/.cache', bytes: 50 }]))
      .toEqual([{ kind: 'pip', bytes: 80, paths: ['/h/.cache/pip'] }, { kind: 'cache', bytes: 0, paths: ['/h/.cache'] }]);
  });
});

describe('hopperDiskOf with caches and container storage', () => {
  const storage = [{ runtime: 'podman' as const, kind: 'images' as const, bytes: 9, reclaimableBytes: 4 }];

  it('carries them beside the hopper\'s own places, which alone count against the budget', () => {
    const d = hopperDiskOf([{ path: '/w/.worktrees', bytes: 10 }], at, { bytes: 15 }, { caches: [{ kind: 'npm', path: '/h/.npm', bytes: 30 }], storage });
    expect(d).toEqual({ bytes: 10, at, paths: [{ path: '/w/.worktrees', bytes: 10 }], budgetBytes: 15, over: false,
      caches: [{ kind: 'npm', bytes: 30, paths: ['/h/.npm'] }], storage });
  });

  it('is a measure when only caches or storage were measured; nothing measured is none', () => {
    expect(hopperDiskOf([], at, undefined, { storage })).toEqual({ bytes: 0, at, paths: [], over: false, storage });
    expect(hopperDiskOf([], at, undefined, { caches: [], storage: [] })).toBeUndefined();
    expect(hopperDiskOf(undefined, at, undefined)).toBeUndefined();
  });
});
