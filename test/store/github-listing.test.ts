// The listing cache (issue #985, tenant migration 52): each repository's latest listing, with when it was read. A new
// listing replaces the one before, so an item gone from it (closed, unlabelled) is gone from the cache. A listing keeps
// where its next change read starts (issue #1276, tenant migration 61).
import { describe, expect, it } from 'vitest';
import type { ListedItem } from '../../src/domain/github-listing.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const item = (number: number, over: Partial<ListedItem> = {}): ListedItem => ({
  repo: 'o/r', number, kind: 'issue', url: `https://github.com/o/r/issues/${number}`, title: `T${number}`, author: 'dev',
  labels: ['hopper'], assignees: ['dev'], updatedAt: '2026-10-13T10:00:00Z', ...over,
});
const pull = item(7, {
  kind: 'pull', url: 'https://github.com/o/r/pull/7',
  pull: { isDraft: false, headRef: 'issue-1', headOid: 'abc', base: 'dev', mergeable: 'MERGEABLE', checks: 'pending' },
});

describe('the listing cache', () => {
  it('keeps a repository\'s listing and when it was read', () => {
    const store = t.open(t.url());
    expect(store.githubListings.listing('o/r')).toBeUndefined();
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:05:00.000Z', since: '2026-10-13T10:00:00Z', items: [item(1), pull] });
    expect(store.githubListings.listing('o/r')).toEqual({ fetchedAt: '2026-10-13T10:05:00.000Z', since: '2026-10-13T10:00:00Z', items: [item(1), pull] });
    expect(store.githubListings.item('o/r', 7)).toEqual(pull);
    expect(store.githubListings.item('o/r', 2)).toBeUndefined();
    expect(store.githubListings.listing('o/other')).toBeUndefined();
    store.close();
  });

  it('a new listing replaces the one before: an item gone from it is gone', () => {
    const store = t.open(t.url());
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:05:00.000Z', items: [item(1), item(2)] });
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:20:00.000Z', items: [item(2, { title: 'New' })] });
    expect(store.githubListings.listing('o/r')).toEqual({ fetchedAt: '2026-10-13T10:20:00.000Z', items: [item(2, { title: 'New' })] });
    expect(store.githubListings.item('o/r', 1)).toBeUndefined();
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:35:00.000Z', items: [] });
    expect(store.githubListings.listing('o/r')).toEqual({ fetchedAt: '2026-10-13T10:35:00.000Z', items: [] });
    store.close();
  });

  it('keeps a listing with no change-read start (issue #1276)', () => {
    const store = t.open(t.url());
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:05:00.000Z', items: [] });
    expect(store.githubListings.listing('o/r')).toStrictEqual({ fetchedAt: '2026-10-13T10:05:00.000Z', items: [] });
    store.close();
  });

  it('forgets a repository no longer listed', () => {
    const store = t.open(t.url());
    store.githubListings.record('o/r', { fetchedAt: '2026-10-13T10:05:00.000Z', items: [item(1)] });
    store.githubListings.record('o/s', { fetchedAt: '2026-10-13T10:05:00.000Z', items: [item(1, { repo: 'o/s' })] });
    store.githubListings.forget('o/r');
    expect(store.githubListings.listing('o/r')).toBeUndefined();
    expect(store.githubListings.item('o/r', 1)).toBeUndefined();
    expect(store.githubListings.item('o/s', 1)).toEqual(item(1, { repo: 'o/s' }));
    store.close();
  });
});
