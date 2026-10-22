// A failed job's locked entry dismissed (issue #1892 part 20): its item is dropped, and the ledger keeps that the dismiss
// dropped it while it stays dropped. Its issue keeps `hopper:failed`, so the label mirror can judge it. Any move forgets it.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
const j2: LedgerJob = { id: 'j2', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-22T12:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?, LedgerJob?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data, job] of steps) item = applyEvent(item, ev(type, data), KEY, job ?? j1) ?? item;
  return item;
}

describe('a failed job\'s locked entry dismissed (issue #1892 part 20)', () => {
  it('drops the item, and the ledger keeps that the dismiss dropped it', () => {
    const item = fold([['job.queued'], ['job.started'], ['job.failed', { error: 'boom' }], ['job.dismissed', { by: 'user' }]])!;
    expect(item).toMatchObject({ state: 'dropped', dismissed: true });
  });

  it('a cancel drops the item with no such mark', () => {
    expect(fold([['job.queued'], ['job.started'], ['job.cancelled', { reason: 'cancelled in UI' }]])!.dismissed).toBeUndefined();
  });

  it('a hand-off or a new job forgets it', () => {
    const dismissed = fold([['job.queued'], ['job.failed', { error: 'boom' }], ['job.dismissed', { by: 'user' }]])!;
    const handedOff = fold([['handoff.opened', { handoffId: 'h1', reason: 'dismissed' }]], dismissed)!;
    expect(handedOff.state).toBe('needs_you');
    expect(handedOff.dismissed).toBeUndefined();
    const queued = fold([['job.queued', {}, j2]], dismissed)!;
    expect(queued.state).toBe('queued');
    expect(queued.dismissed).toBeUndefined();
  });
});
