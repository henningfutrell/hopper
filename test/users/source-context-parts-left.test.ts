// A partly done item's fact for the label mirror (issue #1892): its job's follow recorded the merge of a part, and not every
// declared part is done. Only then is no end label its labels, and Intake takes it again for its next part.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const KEY = 'https://github.com/o/r/issues/7';

const partsLeftOf = (source: Record<string, unknown> | undefined, jobId = 'j1'): boolean => {
  const store = {
    settings: { claimHolder: () => 'a1b2c3d4e5f6' },
    workItems: { get: (key: string) => (key === KEY ? { key, jobId } : undefined) },
    jobs: { get: (id: string) => (id === 'j1' ? { id, status: 'finished', ...(source ? { sourceState: { source } } : {}) } : undefined) },
  } as unknown as UserStore;
  return storeSourceContext(store, undefined, undefined).intake('github')!.partsLeft!(KEY);
};

describe('partsLeft: a part merged with parts left (issue #1892)', () => {
  it('the follow recorded a merged part: parts are left, unless every declared part is done', () => {
    expect(partsLeftOf({ pullRequest: 'https://github.com/o/r/pull/9', follow: 'merged', part: true })).toBe(true);
    expect(partsLeftOf({ follow: 'merged', part: true, parts: { done: 1, total: 3 } })).toBe(true);
    expect(partsLeftOf({ follow: 'merged', part: true, parts: { done: 3, total: 3 } })).toBe(false);
  });

  it('no merged part recorded, or its job not in the store: none', () => {
    expect(partsLeftOf({ follow: 'open', part: true })).toBe(false);
    expect(partsLeftOf({ follow: 'merged' })).toBe(false);
    expect(partsLeftOf(undefined)).toBe(false);
    expect(partsLeftOf({ follow: 'merged', part: true }, 'gone')).toBe(false);
  });
});
