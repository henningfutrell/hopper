// The hopper's own close (issue #1892 part 22): pull request housekeeping closes a finished job's pull request that has
// nothing left to land (`superseded`). Its item is dropped, and the ledger keeps that the hopper's close dropped it while it
// stays dropped and its issue stays open: the follow put `hopper:pr-closed` on its issue. A close because another pull
// request closed the issue puts `hopper:done` on, and its issue is closed: once the ledger knows that, the mark is gone.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-22T14:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, job ?? j1) ?? item;
  return item;
}

const prOpen = (): WorkItem => fold([['job.queued'], ['job.started'], ['job.pull_request_followed', { pullRequest: PR }], ['job.finished', { result: 'pull request opened' }]])!;
const housekept = { pullRequest: PR, superseded: 'its changes are already on main' };

describe('the hopper\'s own close (issue #1892 part 22)', () => {
  it('drops the item, and the ledger keeps that the hopper\'s close dropped it', () => {
    const item = fold([['job.pull_request_closed', housekept]], prOpen())!;
    expect(item).toMatchObject({ state: 'dropped', pullRequestState: 'closed', closedByHopper: true });
    expect(item.closedByPerson).toBeUndefined();
  });

  it('a person\'s Close PR and a close on GitHub leave no such mark', () => {
    expect(fold([['job.pull_request_closed', { pullRequest: PR, person: 'user', via: 'ui' }]], prOpen())!.closedByHopper).toBeUndefined();
    expect(fold([['job.pull_request_closed', { pullRequest: PR }]], prOpen())!.closedByHopper).toBeUndefined();
  });

  it('its issue closed forgets it, before or after the close, and a reopen does not bring it back', () => {
    const after = fold([['job.pull_request_closed', housekept], ['work_item.issue_closed', { key: KEY }]], prOpen())!;
    expect(after.closedByHopper).toBeUndefined();
    expect(fold([['work_item.issue_reopened', { key: KEY }]], after)!).toMatchObject({ state: 'dropped' });
    expect(fold([['work_item.issue_reopened', { key: KEY }]], after)!.closedByHopper).toBeUndefined();
    const before = fold([['work_item.issue_closed', { key: KEY }], ['job.pull_request_closed', housekept]], prOpen())!;
    expect(before.closedByHopper).toBeUndefined();
  });

  it('a new job forgets it', () => {
    const closed = fold([['job.pull_request_closed', housekept]], prOpen())!;
    const queued = fold([['job.queued', {}, j2]], closed)!;
    expect(queued.state).toBe('queued');
    expect(queued.closedByHopper).toBeUndefined();
  });
});
