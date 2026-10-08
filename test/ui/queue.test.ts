// Issue #159: the Queue view's two columns — the pre-sort (jobs not yet accepted, in the pre-sort's
// order, with what it would reject) and the user order (accepted waiting jobs, in queue order) — and
// the orders a move posts. Issue #201: the count of jobs waiting on the pre-sort (the nav badge).
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { accepting, awaitingSort, moved, queueColumns } from '../../ui/src/model/queue.ts';

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
  const abc = [job('a'), job('b'), job('c')];
  it('moving a job up, down, to the top; at an edge nothing moves', () => {
    expect(moved(abc, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moved(abc, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moved(abc, 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moved(abc, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moved(abc, 'c', 1)).toEqual(['a', 'b', 'c']);
  });
  it('a job moves among jobs of its own priority only (issue #461): the top is the top of its priority', () => {
    const mixed = [job('h', { priority: 75 }), job('a'), job('b'), job('l', { priority: 25 })];
    expect(moved(mixed, 'a', -1)).toEqual(['h', 'a', 'b', 'l']);
    expect(moved(mixed, 'b', 'top')).toEqual(['h', 'b', 'a', 'l']);
    expect(moved(mixed, 'b', 1)).toEqual(['h', 'a', 'b', 'l']);
    expect(moved(mixed, 'l', -1)).toEqual(['h', 'a', 'b', 'l']);
  });
});

describe('awaitingSort', () => {
  it('counts the waiting jobs not yet accepted: the Queue nav badge', () => {
    const jobs = [job('a1'), job('n1', { accepted: false }), job('n2', { status: 'held', accepted: false }), job('r1', { status: 'running', accepted: false }), job('x1', { status: 'rejected', accepted: false })];
    expect(awaitingSort(jobs)).toBe(2);
    expect(awaitingSort([])).toBe(0);
  });
});
