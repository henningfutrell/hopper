// A partly done item's fact for the label mirror (issue #1892): its job's follow recorded the merge of a part, and not every
// declared part is done. Only then is no end label its labels, and Intake takes it again for its next part. Its other fact
// (part 35): the merged part made every declared part done, so the follow put `hopper:done` on.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const KEY = 'https://github.com/o/r/issues/7';

const factOf = (fact: 'partsLeft' | 'lastPartMerged') => (source: Record<string, unknown> | undefined, jobId = 'j1'): boolean => {
  const store = {
    settings: { claimHolder: () => 'a1b2c3d4e5f6' },
    workItems: { get: (key: string) => (key === KEY ? { key, jobId } : undefined) },
    jobs: { get: (id: string) => (id === 'j1' ? { id, status: 'finished', ...(source ? { sourceState: { source } } : {}) } : undefined) },
  } as unknown as UserStore;
  return storeSourceContext(store, undefined, undefined).intake('github')![fact]!(KEY);
};
const partsLeftOf = factOf('partsLeft');
const lastPartOf = factOf('lastPartMerged');

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

describe('lastPartMerged: the last part merged (issue #1892 part 35)', () => {
  it('the follow recorded a merged part that made every declared part done', () => {
    expect(lastPartOf({ follow: 'merged', part: true, parts: { done: 3, total: 3 } })).toBe(true);
    expect(lastPartOf({ follow: 'merged', part: true, parts: { done: 1, total: 3 } })).toBe(false);
    expect(lastPartOf({ follow: 'merged', part: true })).toBe(false);
    expect(lastPartOf({ follow: 'open', part: true, parts: { done: 3, total: 3 } })).toBe(false);
    expect(lastPartOf({ follow: 'merged', part: true, parts: { done: 3, total: 3 } }, 'gone')).toBe(false);
  });
});

// Part 37: the merge an older job's follow recorded. A tend or a new job of the item can end before an older job's pull
// request merges (any job's merge counts, the ledger says): the item's newest job then has no merge of its own.
describe('a part merged by an older job of the item (issue #1892 part 37)', () => {
  const PR = 'https://github.com/o/r/pull/9';
  const olderOf = (fact: 'partsLeft' | 'lastPartMerged', older: Record<string, unknown>, item: Record<string, unknown> = { pullRequest: PR, pullRequestState: 'merged' }): boolean => {
    const jobs = new Map<string, unknown>([
      ['j2', { id: 'j2', status: 'cancelled', sourceState: { source: { follow: 'open' } } }],
      ['j1', { id: 'j1', status: 'finished', sourceState: { source: older } }],
    ]);
    const store = {
      settings: { claimHolder: () => 'a1b2c3d4e5f6' },
      workItems: { get: (key: string) => (key === KEY ? { key, jobId: 'j2', ...item } : undefined) },
      jobs: {
        get: (id: string) => jobs.get(id),
        idsOfItem: (key: string) => (key === KEY ? ['j2', 'j1'] : []),
        getMany: (ids: readonly string[]) => new Map(ids.filter((id) => jobs.has(id)).map((id) => [id, jobs.get(id)])),
      },
    } as unknown as UserStore;
    return storeSourceContext(store, undefined, undefined).intake('github')![fact]!(KEY);
  };

  it('the older job whose follow recorded the merge of the item\'s pull request decides', () => {
    expect(olderOf('partsLeft', { pullRequest: PR, follow: 'merged', part: true, parts: { done: 1, total: 3 } })).toBe(true);
    expect(olderOf('lastPartMerged', { pullRequest: PR, follow: 'merged', part: true, parts: { done: 3, total: 3 } })).toBe(true);
  });

  it('not a merge of another pull request, nor while the item\'s pull request is not merged', () => {
    expect(olderOf('partsLeft', { pullRequest: 'https://github.com/o/r/pull/8', follow: 'merged', part: true })).toBe(false);
    expect(olderOf('partsLeft', { pullRequest: PR, follow: 'merged', part: true }, { pullRequest: PR, pullRequestState: 'open' })).toBe(false);
    expect(olderOf('partsLeft', { pullRequest: PR, follow: 'merged', part: true }, {})).toBe(false);
  });
});
