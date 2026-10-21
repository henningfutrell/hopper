// A job moved off a machine goes back to the queue through the item ledger (issue #1892, milestone 3). The hopper parks
// it to move it — the signed-out move, the busy-machine move, the lost-machine move — and picks it up elsewhere: no person
// holds it. Its park names the move (`move`), so the item goes back to queued, owned by the scheduler, and not to needs
// you. A park a person or a wait made still waits on a person.
import { describe, expect, it } from 'vitest';
import { transitionOwner } from '../../src/domain/item-lifecycle.ts';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-21T11:${String(minute++).padStart(2, '0')}:00.000Z`, data });

function fold(steps: [EventType, Record<string, unknown>?][], from?: WorkItem): WorkItem | undefined {
  let item = from;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, j1) ?? item;
  return item;
}

describe('a job moved off a machine (issue #1892)', () => {
  it('a park to move a running job keeps its item in the queue, not at a person', () => {
    const working = fold([['job.queued'], ['job.started']]);
    const parked = fold([['job.parked', { from: 'running', auto: true, why: 'its machine stayed away', move: 'lost_machine' }]], working);
    expect(parked).toMatchObject({ state: 'queued', waitingOn: 'a move to another machine' });
    expect(fold([['job.unparked', { to: 'queued', elsewhere: true }]], parked)).toMatchObject({ state: 'queued' });
  });

  it('a job on a not-signed-in question moved off its machine goes from needs you back to the queue', () => {
    const asked = fold([['job.queued'], ['job.started'], ['question.escalated_to_human']]);
    expect(asked?.state).toBe('needs_you');
    expect(fold([['job.parked', { from: 'waiting_answer', move: 'signed_out' }]], asked)).toMatchObject({ state: 'queued', waitingOn: 'a move to another machine' });
  });

  it('a park with no move still waits on a person', () => {
    const working = fold([['job.queued'], ['job.started']]);
    expect(fold([['job.parked', { from: 'running', by: 'someone', via: 'ui' }]], working)).toMatchObject({ state: 'needs_you', waitingOn: 'a person to pick up the parked job' });
    expect(fold([['job.parked', { from: 'waiting_answer', auto: true, why: 'the question waited 30 min' }]], working)?.state).toBe('needs_you');
  });

  it('the move is the scheduler\'s; a pick up a person made is the person\'s', () => {
    expect(transitionOwner('job.parked', { move: 'busy_machine' })).toBe('scheduler');
    expect(transitionOwner('job.parked', { by: 'someone' })).toBe('person');
    expect(transitionOwner('job.unparked', { to: 'queued', elsewhere: true })).toBe('scheduler');
    expect(transitionOwner('job.unparked', { to: 'queued', by: 'someone', via: 'ui' })).toBe('person');
  });
});
