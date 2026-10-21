// A label a person took off by hand on GitHub (issue #1892, `work_item.label_edited`): the ledger keeps that the person
// asked for a Run again while the item stays in the state it was seen in. Its state does not change: the new job's
// `job.queued` moves it, and any move forgets the ask.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import { transitionOwner } from '../../src/domain/item-lifecycle.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-18T11:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, type.startsWith('work_item.') ? undefined : job ?? j1) ?? item;
  return item;
}

const edited = (from: string, label: string): [EventType, Record<string, unknown>] =>
  ['work_item.label_edited', { source: 'github', key: KEY, jobId: 'j1', from, label, means: 'run_again' }];

describe('a label taken off by hand (issue #1892)', () => {
  it('a blocked item keeps the person\'s Run again; its state stays; it is a person\'s move', () => {
    const blocked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }]])!;
    const after = applyEvent(blocked, ev(...edited('blocked', 'hopper:pr-closed')), KEY)!;
    expect(after).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', runAgainAsked: 'hopper:pr-closed', stateSince: blocked.stateSince });
    expect(applyEvent(after, ev(...edited('blocked', 'hopper:pr-closed')), KEY)).toBeUndefined();
    expect(transitionOwner('work_item.label_edited')).toBe('person');
  });

  it('changes nothing when the item is no longer in the state it was seen in, or is not known', () => {
    const working = fold([['job.queued'], ['job.started']])!;
    expect(applyEvent(working, ev(...edited('blocked', 'hopper:blocked')), KEY)).toBeUndefined();
    expect(applyEvent(undefined, ev(...edited('blocked', 'hopper:blocked')), KEY)).toBeUndefined();
  });

  it('the new job\'s queue moves the item and forgets the ask', () => {
    const asked = fold([['job.queued'], ['job.finished', {}], ['job.pull_request_closed', { pullRequest: PR, part: false }], edited('blocked', 'hopper:pr-closed')])!;
    expect(asked.runAgainAsked).toBe('hopper:pr-closed');
    const queued = fold([['job.queued', {}, j2]], asked)!;
    expect(queued.state).toBe('queued');
    expect(queued.runAgainAsked).toBeUndefined();
  });
});
