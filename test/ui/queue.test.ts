// Issue #159: the Queue view's two columns — the pre-sort (jobs not yet accepted, in the pre-sort's
// order, with what it would reject) and the user order (accepted waiting jobs, in queue order) — and
// the orders a move posts.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { accepting, moved, queueColumns } from '../../ui/src/model/queue.ts';

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'queued', approved: false,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0, ...o,
} as Job);

describe('queueColumns', () => {
  it('splits waiting jobs: unaccepted in pre-sort order with its rejections, accepted in queue order', () => {
    const waiting = [job('a1'), job('n1', { accepted: false }), job('a2', { status: 'held', accepted: true }), job('n2', { accepted: false }), job('n3', { accepted: false })];
    const c = queueColumns(waiting, { sorter: 'priority', jobIds: ['n2', 'n1'], reject: [{ jobId: 'n1', reason: 'spam' }] });
    expect(c.presorted.map((r) => [r.job.id, r.reject])).toEqual([['n2', undefined], ['n1', 'spam'], ['n3', undefined]]);
    expect(c.userOrder.map((j) => j.id)).toEqual(['a1', 'a2']);
  });

  it('empty: no columns to fill', () => {
    expect(queueColumns([], undefined)).toEqual({ presorted: [], userOrder: [] });
  });
});

describe('the orders a move posts', () => {
  it('accepting a pre-sorted job appends it to the user order', () => {
    expect(accepting(['a', 'b'], 'n')).toEqual(['a', 'b', 'n']);
  });
  it('moving a job up, down, to the top; at an edge nothing moves', () => {
    expect(moved(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});
