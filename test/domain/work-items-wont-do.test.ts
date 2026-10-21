// Won't do on a blocked item (issue #1891): a person's `work_item.dropped` ends a blocked item as dropped. It moves only a
// blocked item, so a second one, or one on an item a job took again since, changes nothing.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { transitionOwner } from '../../src/domain/item-lifecycle.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-18T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?][]): WorkItem | undefined {
  let item: WorkItem | undefined;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, type.startsWith('work_item.') ? undefined : j1) ?? item;
  return item;
}

const dropped = ['work_item.dropped', { source: 'github', key: KEY, by: { person: 'someone', via: 'ui' } }] as [EventType, Record<string, unknown>];

describe('Won\'t do on a blocked item', () => {
  it('drops a blocked item, and is a person\'s move', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]]);
    expect(blocked).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed' });
    const after = applyEvent(blocked, ev(...dropped), KEY);
    expect(after).toMatchObject({ state: 'dropped', jobId: 'j1' });
    expect(after?.blockedCause).toBeUndefined();
    expect(after?.waitingOn).toBeUndefined();
    expect(transitionOwner('work_item.dropped')).toBe('person');
  });

  it('a second one, or one on an item that is not blocked, changes nothing', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]])!;
    const after = applyEvent(blocked, ev(...dropped), KEY)!;
    expect(applyEvent(after, ev(...dropped), KEY)).toBeUndefined();
    const queued = fold([['job.queued']])!;
    expect(applyEvent(queued, ev(...dropped), KEY)).toBeUndefined();
    expect(applyEvent(undefined, ev(...dropped), KEY)).toBeUndefined();
  });

  it('marks the item dropped by Won\'t do (issue #1892), and a new job of it forgets that', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]])!;
    const after = applyEvent(blocked, ev(...dropped), KEY)!;
    expect(after.wontDo).toBe(true);
    expect(applyEvent(after, ev('job.queued'), KEY, { ...j1, id: 'j2' })?.wontDo).toBeUndefined();
  });

  it('a hand-off resolved as Won\'t do is dropped by Won\'t do; a cancelled job or a dismissed failure is not (issue #1892)', () => {
    const handoff = fold([['job.queued'], ['job.failed'], ['handoff.opened'], ['handoff.closed', { end: 'wont_do' }]]);
    expect(handoff).toMatchObject({ state: 'dropped', wontDo: true });
    expect(fold([['job.queued'], ['job.cancelled']])).toMatchObject({ state: 'dropped' });
    expect(fold([['job.queued'], ['job.cancelled']])?.wontDo).toBeUndefined();
    expect(fold([['job.queued'], ['job.failed'], ['job.dismissed']])?.wontDo).toBeUndefined();
  });
});
