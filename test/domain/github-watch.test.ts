// GitHub watches (issue #427): what a poll saw of a watched item, compared with the snapshot before it. A change is one
// set of typed changes; no change is none, so the watch emits nothing.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GITHUB_WATCH, GITHUB_WATCH_INTERVAL, githubWatchChanges, githubWatchSettingsOf, watched, type WatchSnapshot,
} from '../../src/domain/github-watch.ts';
import type { PointedJob } from '../../src/domain/pointed-jobs.ts';

const base: WatchSnapshot = {
  state: 'open', labels: ['bug', 'hopper'], comments: [{ id: 1, author: 'ann', at: '2026-10-11T00:00:00Z' }],
  reviews: [], linkedPullRequests: [],
};

describe('githubWatchChanges', () => {
  it('is undefined when nothing changed, whatever the order GitHub listed labels and links in', () => {
    expect(githubWatchChanges(base, { ...base, labels: ['hopper', 'bug'] })).toBeUndefined();
    const linked = { ...base, linkedPullRequests: ['https://x/pull/2', 'https://x/pull/1'] };
    expect(githubWatchChanges(linked, { ...linked, linkedPullRequests: ['https://x/pull/1', 'https://x/pull/2'] })).toBeUndefined();
  });

  it('names the labels added and removed', () => {
    expect(githubWatchChanges(base, { ...base, labels: ['hopper', 'ready'] })).toEqual({ labels: { added: ['ready'], removed: ['bug'] } });
  });

  it('names the comments added, and how many went', () => {
    const c2 = { id: 2, author: 'bob', at: '2026-10-11T01:00:00Z' };
    expect(githubWatchChanges(base, { ...base, comments: [...base.comments, c2] })).toEqual({ comments: { added: [c2], removed: 0 } });
    expect(githubWatchChanges(base, { ...base, comments: [] })).toEqual({ comments: { added: [], removed: 1 } });
  });

  it('names a change of state with its reason, and a merge as the state merged', () => {
    expect(githubWatchChanges(base, { ...base, state: 'closed', stateReason: 'completed' }))
      .toEqual({ state: { from: 'open', to: 'closed', reason: 'completed' } });
    expect(githubWatchChanges(base, { ...base, state: 'merged', mergedAt: '2026-10-11T02:00:00Z' }))
      .toEqual({ state: { from: 'open', to: 'merged', mergedAt: '2026-10-11T02:00:00Z' } });
  });

  it('names the reviews added and the pull requests linked and unlinked', () => {
    const review = { id: 9, author: 'cy', state: 'approved', at: '2026-10-11T03:00:00Z' };
    expect(githubWatchChanges({ ...base, linkedPullRequests: ['https://x/pull/1'] }, { ...base, reviews: [review], linkedPullRequests: ['https://x/pull/3'] }))
      .toEqual({ reviews: { added: [review] }, linkedPullRequests: { added: ['https://x/pull/3'], removed: ['https://x/pull/1'] } });
  });

  it('puts every change of one poll in one set', () => {
    const changes = githubWatchChanges(base, { ...base, state: 'closed', labels: ['hopper'], comments: [] });
    expect(Object.keys(changes ?? {}).sort()).toEqual(['comments', 'labels', 'state']);
  });
});

describe('the settings', () => {
  it('default to a minute, and keep a saved interval within its range', () => {
    expect(githubWatchSettingsOf(undefined)).toEqual(DEFAULT_GITHUB_WATCH);
    expect(DEFAULT_GITHUB_WATCH.intervalSeconds).toBe(60);
    expect(githubWatchSettingsOf({ intervalSeconds: 5 }).intervalSeconds).toBe(GITHUB_WATCH_INTERVAL.min);
    expect(githubWatchSettingsOf({ intervalSeconds: 1e9 }).intervalSeconds).toBe(GITHUB_WATCH_INTERVAL.max);
    expect(githubWatchSettingsOf({ intervalSeconds: 300 }).intervalSeconds).toBe(300);
  });
});

describe('watched', () => {
  const job = (status: PointedJob['status']): PointedJob => ({
    id: 'p1', repo: 'o/r', pointer: { kind: 'issue', number: 1, url: 'https://x/o/r/issues/1' }, directive: 'd', status, source: 'api',
    createdAt: '', updatedAt: '',
  });
  it('is every pointed job that has not ended', () => {
    expect(['queued', 'running', 'awaiting_review'].every((s) => watched(job(s as PointedJob['status'])))).toBe(true);
    expect(watched(job('merged')) || watched(job('abandoned'))).toBe(false);
  });
});
