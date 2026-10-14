// What the ledger-vs-GitHub watcher reads (issue #1077): the state of many issues and pull requests in one GraphQL call,
// each by its URL (`resource(url:)`), and the drift issue found by its drift key in its body.
import { describe, expect, it } from 'vitest';
import { STATES_BATCH, statesFrom, statesQuery } from '../../src/component-watchers/github.ts';

describe('the batched state read', () => {
  it('asks for every URL in one query, each as a variable, never in the query text', () => {
    const q = statesQuery(['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2']);
    expect(q.variables).toEqual({ u0: 'https://github.com/o/r/issues/1', u1: 'https://github.com/o/r/pull/2' });
    expect(q.query).toContain('i0: resource(url: $u0)');
    expect(q.query).toContain('i1: resource(url: $u1)');
    expect(q.query).not.toContain('github.com');
    expect(STATES_BATCH).toBeGreaterThan(1);
  });

  it('reads an issue and a pull request: the state, why an issue closed, and when it changed', () => {
    const urls = ['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/3', 'https://github.com/o/r/issues/4'];
    const states = statesFrom(urls, {
      i0: { __typename: 'Issue', state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-13T10:00:00Z' },
      i1: { __typename: 'PullRequest', state: 'MERGED', merged: true, mergedAt: '2026-10-13T09:00:00Z', closedAt: '2026-10-13T09:00:00Z' },
      i2: { __typename: 'PullRequest', state: 'OPEN', merged: false, mergedAt: null, closedAt: null },
      i3: null,
    });
    expect([...states.values()]).toEqual([
      { url: urls[0], state: 'closed', stateReason: 'completed', changedAt: '2026-10-13T10:00:00Z' },
      { url: urls[1], state: 'merged', changedAt: '2026-10-13T09:00:00Z' },
      { url: urls[2], state: 'open' },
    ]);
  });
});
