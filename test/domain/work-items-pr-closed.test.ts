// A pull request closed without a merge on GitHub (issue #1891): the work-item reducer blocks its item (`pr_closed`) and
// counts the closes in a row; a person's Close PR or the hopper's close as superseded still drops it.
import { describe, expect, it } from 'vitest';
import { applyEvent, applyRead, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-13T10:${String(minute++).padStart(2, '0')}:00.000Z`, data });

/** Fold `steps` from no item, each `[type, data, job]`. */
function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][]): WorkItem | undefined {
  let item: WorkItem | undefined;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, job ?? j1) ?? item;
  return item;
}

describe('a pull request closed without a merge', () => {
  it('a pull request closed without a merge on GitHub blocks the item (issue #1891); a second in a row counts two, a merge ends the row', () => {
    const PR2 = 'https://github.com/o/r/pull/3';
    const first = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]]);
    expect(first).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 1, pullRequest: PR, pullRequestState: 'closed', waitingOn: 'a person: its pull request was closed without a merge' });
    // Run again: a new job takes the item over, the row of closes stays.
    const again = applyEvent(first, ev('job.queued'), KEY, j2)!;
    expect(again).toMatchObject({ state: 'queued', closedWithoutMerge: 1 });
    expect(again.blockedCause).toBeUndefined();
    const second = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }],
      ['job.queued', {}, j2], ['job.finished', {}, j2], ['job.pull_request_closed', { pullRequest: PR2, part: false }, j2]]);
    expect(second).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 2, pullRequest: PR2 });
    const merged = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }],
      ['job.queued', {}, j2], ['job.finished', {}, j2], ['job.pull_request_merged', { pullRequest: PR2, part: true }, j2]]);
    expect(merged).toMatchObject({ state: 'partly_done' });
    expect(merged?.closedWithoutMerge).toBeUndefined();
    // Its issue closed as not planned since: dropped, as any item no job acts on.
    expect(applyRead(first!, { kind: 'issue', at: '2026-10-13T12:00:00.000Z', state: 'closed', reason: 'not_planned' })?.state).toBe('dropped');
  });

});
