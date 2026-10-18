// One notice when an item is blocked (issue #1891): the item reconciler asks a person once (`work_item.person_asked`), and the
// item keeps that it asked while it stays blocked for the same cause. A move out of blocked, or a new cause, asks again later.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { transitionOwner } from '../../src/domain/item-lifecycle.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-18T11:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, type.startsWith('work_item.') ? undefined : j1) ?? item;
  return item;
}

const asked: [EventType, Record<string, unknown>] = ['work_item.person_asked', { key: KEY, cause: 'pr_closed', jobId: 'j1' }];

describe('one notice when an item is blocked', () => {
  it('marks a blocked item asked, once, and is the reconciler\'s move; its state stays', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]])!;
    expect(blocked.personAsked).toBeUndefined();
    const after = applyEvent(blocked, ev(...asked), KEY)!;
    expect(after).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', personAsked: true, stateSince: blocked.stateSince });
    expect(applyEvent(after, ev(...asked), KEY)).toBeUndefined();
    expect(transitionOwner('work_item.person_asked')).toBe('reconciler');
  });

  it('changes nothing on an item that is not blocked', () => {
    expect(applyEvent(fold([['job.queued']]), ev(...asked), KEY)).toBeUndefined();
    expect(applyEvent(undefined, ev(...asked), KEY)).toBeUndefined();
  });

  it('a move out of blocked forgets it: blocked again, the item is asked again', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }], asked])!;
    expect(blocked.personAsked).toBe(true);
    const again = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: `${PR}1`, part: false }]], blocked)!;
    expect(again).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 2 });
    expect(again.personAsked).toBeUndefined();
  });

  it('a new cause asks again', () => {
    const noPr = fold([['job.queued'], ['job.finished', {}]])!;
    expect(noPr).toMatchObject({ state: 'blocked', blockedCause: 'no_pr' });
    const asksNoPr = applyEvent(noPr, ev('work_item.person_asked', { key: KEY, cause: 'no_pr' }), KEY)!;
    const closed = fold([['job.pull_request_closed', { pullRequest: PR, part: false }]], asksNoPr)!;
    expect(closed).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed' });
    expect(closed.personAsked).toBeUndefined();
  });
});
