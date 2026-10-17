// Issue #159: the Queue view's two columns — the pre-sort (jobs not yet accepted, in the pre-sort's
// order, with what it would reject) and the user order (accepted waiting jobs, in queue order) — and
// the orders a move posts. Issue #201: the count of jobs waiting on the pre-sort (the nav badge). Issue #737: which job
// cards are open — collapsed by default, one opened or closed on its own, or all at once. Issue #1776: a move to any place,
// Accept at the top, and what a job shows about its priority.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { COLLAPSED, accepting, awaitingSort, cardOpen, moved, orderNotes, queueColumns, setAllCards, stillWhy, toggleCard } from '../../ui/src/model/queue.ts';

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
  it('accepting a pre-sorted job appends it to the user order, or puts it at the top (issue #1776)', () => {
    expect(accepting(['a', 'b'], 'n')).toEqual(['a', 'b', 'n']);
    expect(accepting(['a', 'b'], 'n', 'top')).toEqual(['n', 'a', 'b']);
  });
  const abc = ['a', 'b', 'c'];
  it('moving a job up, down, to the top; at an edge nothing moves, and says why', () => {
    expect(moved(abc, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moved(abc, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moved(abc, 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moved(abc, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moved(abc, 'c', 1)).toEqual(['a', 'b', 'c']);
    expect([stillWhy(abc, 'a', -1), stillWhy(abc, 'a', 'top'), stillWhy(abc, 'c', 1)]).toEqual(['already first', 'already first', 'already last']);
    expect([stillWhy(abc, 'b', -1), stillWhy(abc, 'b', 1), stillWhy(abc, 'c', 'top')]).toEqual([undefined, undefined, undefined]);
  });
  it('a job moves to any place, whatever the priorities (issue #1776): the top two swap, the top is the top of the order', () => {
    const mixed = ['h75', 'a50', 'b50', 'l25'];
    expect(moved(mixed, 'a50', -1)).toEqual(['a50', 'h75', 'b50', 'l25']);
    expect(moved(mixed, 'h75', 1)).toEqual(['a50', 'h75', 'b50', 'l25']);
    expect(moved(mixed, 'l25', 'top')).toEqual(['l25', 'h75', 'a50', 'b50']);
    expect(stillWhy(mixed, 'l25', 'top')).toBeUndefined();
  });
});

describe('what a job of the user order shows about its priority (issue #1776)', () => {
  it('its boost, with why; a job you placed above a higher-priority job says so', () => {
    const order = [
      job('l', { priority: 25, userRank: 0 }), job('h', { priority: 75, userRank: 1 }),
      job('p', { pendingAnswer: 'yes' }), job('r', { advice: { action: 'run_deterministic', reason: 'x' } } as Partial<Job>), job('s'),
    ];
    const notes = orderNotes(order, { l: 25, h: 75, p: 70, r: 60 });
    expect(notes.get('l')).toEqual({ aboveHigher: 'placed by you above a higher-priority job' });
    expect(notes.get('h')).toEqual({});
    expect(notes.get('p')).toEqual({ boost: 'boosted +20: resuming after an answer' });
    expect(notes.get('r')).toEqual({ boost: 'boosted +10: router advice run_deterministic' });
    // A job /api/queue gave no effective priority for counts at its own; one the sorter placed is not tagged.
    expect(notes.get('s')).toEqual({});
    expect(orderNotes([job('x', { priority: 10 }), job('y', { priority: 90 })], {}).get('x')).toEqual({});
  });
});

describe('awaitingSort', () => {
  it('counts the waiting jobs not yet accepted: the Queue nav badge', () => {
    const jobs = [job('a1'), job('n1', { accepted: false }), job('n2', { status: 'held', accepted: false }), job('r1', { status: 'running', accepted: false }), job('x1', { status: 'rejected', accepted: false })];
    expect(awaitingSort(jobs)).toBe(2);
    expect(awaitingSort([])).toBe(0);
  });
});

describe('open job cards (issue #737)', () => {
  it('every card starts collapsed', () => {
    expect(cardOpen(COLLAPSED, 'a')).toBe(false);
  });
  it('a card opens and closes on its own; the others stay as they are', () => {
    const one = toggleCard(COLLAPSED, 'a');
    expect([cardOpen(one, 'a'), cardOpen(one, 'b')]).toEqual([true, false]);
    expect(cardOpen(toggleCard(one, 'a'), 'a')).toBe(false);
  });
  it('expand all opens every card, then one card closes on its own; collapse all closes every card again', () => {
    const all = setAllCards(true);
    expect([cardOpen(all, 'a'), cardOpen(all, 'b')]).toEqual([true, true]);
    const less = toggleCard(all, 'b');
    expect([cardOpen(less, 'a'), cardOpen(less, 'b')]).toEqual([true, false]);
    const none = setAllCards(false);
    expect([cardOpen(none, 'a'), cardOpen(none, 'b')]).toEqual([false, false]);
  });
});
