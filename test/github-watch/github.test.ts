// What a GitHub watch reads of an item (issue #427): GitHub's answers for the item and its timeline, as one snapshot.
import { describe, expect, it } from 'vitest';
import { snapshotOf } from '../../src/github-watch/index.ts';

describe('snapshotOf', () => {
  it('reads an issue: its state and reason, its labels sorted, its comments, the pull requests that reference it', () => {
    const s = snapshotOf(
      { state: 'closed', state_reason: 'not_planned', labels: [{ name: 'wontfix' }, { name: 'bug' }] },
      [
        { event: 'commented', id: 7, user: { login: 'ann' }, created_at: '2026-10-11T00:00:00Z', body: 'no' },
        { event: 'labeled', label: { name: 'bug' } },
        { event: 'cross-referenced', source: { issue: { html_url: 'https://github.com/o/r/pull/3', pull_request: {} } } },
        { event: 'cross-referenced', source: { issue: { html_url: 'https://github.com/o/r/issues/4' } } },
      ],
    );
    expect(s).toEqual({
      state: 'closed', stateReason: 'not_planned', labels: ['bug', 'wontfix'], comments: [{ id: 7, author: 'ann', at: '2026-10-11T00:00:00Z' }],
      reviews: [], linkedPullRequests: ['https://github.com/o/r/pull/3'],
    });
  });

  it('reads a pull request: merged when GitHub says when, and its reviews', () => {
    const s = snapshotOf(
      { state: 'closed', state_reason: null, labels: [], pull_request: { merged_at: '2026-10-11T05:00:00Z' } },
      [{ event: 'reviewed', id: 90, user: { login: 'cy' }, state: 'APPROVED', submitted_at: '2026-10-11T04:00:00Z' }],
    );
    expect(s).toEqual({
      state: 'merged', mergedAt: '2026-10-11T05:00:00Z', labels: [], comments: [],
      reviews: [{ id: 90, author: 'cy', state: 'approved', at: '2026-10-11T04:00:00Z' }], linkedPullRequests: [],
    });
    expect(snapshotOf({ state: 'open', pull_request: { merged_at: null } }, []).state).toBe('open');
  });
});
