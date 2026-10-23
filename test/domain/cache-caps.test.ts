// The cache caps, pure (issue #2494, design.md "Hopper's own disk use" → "Part 10"): which kinds the sweep clears, and
// which jobs keep it from clearing a machine's caches.
import { describe, expect, it } from 'vitest';
import { cachesInUse, cachesToClear } from '../../src/domain/cache-caps.ts';
import type { Job } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const job = (id: string, status: Job['status'], machineId: string, extra: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'x', payload: {}, machineId }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1, ...extra,
});

describe('cachesToClear (issue #2494)', () => {
  const caches = [{ kind: 'go' as const, path: '/h/go/pkg/mod', bytes: 4 * GIB }, { kind: 'go' as const, path: '/h/.cache/go-build', bytes: 2 * GIB }, { kind: 'pip' as const, path: '/h/.cache/pip', bytes: GIB }];

  it('takes the sum of a kind\'s places against its cap', () => {
    expect(cachesToClear({ go: 5, pip: 5 }, caches, false)).toEqual(['go']);
    expect(cachesToClear({ go: 6 }, caches, false)).toEqual([]);
  });

  it('never a kind with no cap, nor one with nothing there', () => {
    expect(cachesToClear(undefined, caches, true)).toEqual([]);
    expect(cachesToClear({ npm: 0 }, caches, true)).toEqual([]);
  });

  it('while the disk is low, every kind with a cap that holds anything', () => {
    expect(cachesToClear({ go: 100, pip: 100 }, caches, true)).toEqual(['go', 'pip']);
  });
});

describe('cachesInUse (issue #2494)', () => {
  it('a job that has not ended on the machine keeps it', () => {
    expect(cachesInUse('n', [job('a', 'parked', 'n')], [])).toBe('job a is parked there');
    expect(cachesInUse('n', [job('a', 'running', 'x', { laneId: 'n/lane-1' })], [])).toBe('job a is running there');
  });

  it('an ended job, or one on another machine, does not', () => {
    expect(cachesInUse('n', [job('a', 'finished', 'n'), job('b', 'running', 'm')], [])).toBeUndefined();
  });

  it('a job\'s scope or process the survey found there keeps it', () => {
    expect(cachesInUse('n', [], ['c'])).toBe('job c runs there');
  });
});
