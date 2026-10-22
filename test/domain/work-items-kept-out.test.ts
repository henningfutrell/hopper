// An end label a person put on by hand on an item a cancelled or rejected job dropped (issue #1892 part 19,
// `work_item.label_edited` with `means: keep_out`): the ledger keeps the label while the item stays dropped. Its state does
// not change: the person keeps the issue out with it. Any move forgets it.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-22T11:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, type.startsWith('work_item.') ? undefined : job ?? j1) ?? item;
  return item;
}

const keepOut = (from: string, label: string): [EventType, Record<string, unknown>] =>
  ['work_item.label_edited', { source: 'github', key: KEY, jobId: 'j1', from, label, means: 'keep_out' }];

describe('an end label put on a dropped item by hand (issue #1892 part 19)', () => {
  it('a cancelled job\'s item keeps the label; its state stays dropped', () => {
    const dropped = fold([['job.queued'], ['job.started'], ['job.cancelled', { reason: 'cancelled in UI' }]])!;
    expect(dropped.state).toBe('dropped');
    const after = applyEvent(dropped, ev(...keepOut('dropped', 'hopper:rejected')), KEY)!;
    expect(after).toMatchObject({ state: 'dropped', keptOut: 'hopper:rejected', stateSince: dropped.stateSince });
    expect(after.runAgainAsked).toBeUndefined();
    expect(applyEvent(after, ev(...keepOut('dropped', 'hopper:done')), KEY)).toBeUndefined();
  });

  it('changes nothing on an item not dropped, or not in the state it was seen in', () => {
    const working = fold([['job.queued'], ['job.started']])!;
    expect(applyEvent(working, ev(...keepOut('working', 'hopper:rejected')), KEY)).toBeUndefined();
    expect(applyEvent(working, ev(...keepOut('dropped', 'hopper:rejected')), KEY)).toBeUndefined();
  });

  it('taking the label off again asks for a Run again; a new job forgets both', () => {
    const kept = fold([['job.queued'], ['job.rejected', {}], keepOut('dropped', 'hopper:done')])!;
    expect(kept.keptOut).toBe('hopper:done');
    const asked = applyEvent(kept, ev('work_item.label_edited', { source: 'github', key: KEY, jobId: 'j1', from: 'dropped', label: 'hopper:done', means: 'run_again' }), KEY)!;
    expect(asked).toMatchObject({ state: 'dropped', runAgainAsked: 'hopper:done', keptOut: 'hopper:done' });
    const queued = fold([['job.queued', {}, j2]], asked)!;
    expect(queued.state).toBe('queued');
    expect(queued.keptOut).toBeUndefined();
    expect(queued.runAgainAsked).toBeUndefined();
  });
});
