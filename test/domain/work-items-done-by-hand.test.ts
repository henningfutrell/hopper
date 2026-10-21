// Done by hand (issue #1892): a person resolves a hand-off with Done, and its item is done by their hand. The fold marks it
// (`doneByHand`), so the label mirror knows `hopper:done` is its label. A later move forgets the mark.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-21T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?][], from?: WorkItem, job: LedgerJob = j1): WorkItem | undefined {
  let item = from;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, job) ?? item;
  return item;
}

const handedOff: [EventType, Record<string, unknown>?][] = [['job.queued'], ['job.failed'], ['handoff.opened']];
const doneByHand: [EventType, Record<string, unknown>?][] = [
  ['handoff.closed', { end: 'done_by_hand', resolution: 'done_by_hand' }],
  ['job.finished', { result: { summary: 'done by hand' } }],
];

describe('a hand-off resolved as Done by hand (issue #1892)', () => {
  it('makes the item done by hand, through the close and its job\'s finish', () => {
    const closed = fold([...handedOff, doneByHand[0]!]);
    expect(closed).toMatchObject({ state: 'done', eventState: 'done', doneByHand: true });
    expect(closed?.waitingOn).toBeUndefined();
    expect(closed?.failedJobId).toBeUndefined();
    expect(fold([doneByHand[1]!], closed)).toMatchObject({ state: 'done', doneByHand: true });
  });

  it('a new job of it forgets the mark', () => {
    const done = fold([...handedOff, ...doneByHand])!;
    expect(fold([['job.queued']], done, { ...j1, id: 'j2' })?.doneByHand).toBeUndefined();
  });

  it('a done a job\'s end made, or a Done by hand on an item not handed off, is not done by hand', () => {
    expect(fold([['job.queued'], ['job.finished', { result: { summary: 'done by hand' } }]])?.doneByHand).toBeUndefined();
    expect(fold([['job.queued'], ['job.finished', { result: { summary: 'issue closed as complete' } }]])?.doneByHand).toBeUndefined();
    expect(fold([['job.queued'], ['handoff.closed', { end: 'done_by_hand' }]])?.doneByHand).toBeUndefined();
  });
});
