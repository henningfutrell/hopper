// A person's Close PR (issue #1892 part 21): the item of a finished job whose pull request a person closed without a merge
// is dropped, and the ledger keeps that a person's close dropped it while it stays dropped. The follow put `hopper:pr-closed`
// on its issue, so the label mirror can judge it. A close on GitHub, the hopper's own close and any move leave no such mark.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-22T13:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, job ?? j1) ?? item;
  return item;
}

const prOpen = (): WorkItem => fold([['job.queued'], ['job.started'], ['job.pull_request_followed', { pullRequest: PR }], ['job.finished', { result: 'pull request opened' }]])!;

describe('a person\'s Close PR (issue #1892 part 21)', () => {
  it('drops the item, and the ledger keeps that a person\'s close dropped it', () => {
    const item = fold([['job.pull_request_closed', { pullRequest: PR, person: 'user', via: 'ui' }]], prOpen())!;
    expect(item).toMatchObject({ state: 'dropped', pullRequestState: 'closed', closedByPerson: true });
  });

  it('the hopper\'s own close drops the item with no such mark', () => {
    expect(fold([['job.pull_request_closed', { pullRequest: PR, byHopper: true }]], prOpen())!.closedByPerson).toBeUndefined();
    expect(fold([['job.pull_request_closed', { pullRequest: PR, superseded: 'done elsewhere' }]], prOpen())!.closedByPerson).toBeUndefined();
  });

  it('a close on GitHub blocks the item, with no such mark', () => {
    const item = fold([['job.pull_request_closed', { pullRequest: PR }]], prOpen())!;
    expect(item.state).toBe('blocked');
    expect(item.closedByPerson).toBeUndefined();
  });

  it('a new job forgets it', () => {
    const closed = fold([['job.pull_request_closed', { pullRequest: PR, person: 'user', via: 'ui' }]], prOpen())!;
    const queued = fold([['job.queued', {}, j2]], closed)!;
    expect(queued.state).toBe('queued');
    expect(queued.closedByPerson).toBeUndefined();
  });
});
