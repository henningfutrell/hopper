// An item whose job waits on a person's decision says so on its issue (issue #2693): while its question, proposal or research
// report is at a person — parked by itself there or not — its issue carries `hopper:needs-decision`, never a "no pull
// request" label. Any other state takes it off; a person who takes it off asks for nothing.
import { describe, expect, it } from 'vitest';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';
import { END_LABELS, HOPPER_LABELS, LABEL_NEEDS_DECISION } from '../../src/sources/github/labels.ts';
import { labelDrift, labelsFor, labelTakenOff } from '../../src/sources/github/item-labels.ts';

const KEY = 'https://github.com/o/r/issues/1';
const j1: LedgerJob = { id: 'j1', key: KEY, kind: 'github' };
let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-18T12:${String(minute++).padStart(2, '0')}:00.000Z`, data });
const fold = (steps: [EventType, Record<string, unknown>?][]): WorkItem => {
  let item: WorkItem | undefined;
  for (const [type, data] of steps) item = applyEvent(item, ev(type, data), KEY, j1) ?? item;
  return item!;
};

describe('hopper:needs-decision (issue #2693)', () => {
  it('is a hopper label and an end label', () => {
    expect(LABEL_NEEDS_DECISION).toBe('hopper:needs-decision');
    expect(END_LABELS).toContain(LABEL_NEEDS_DECISION);
    expect(HOPPER_LABELS.map((l) => l.name)).toContain(LABEL_NEEDS_DECISION);
  });

  it('is what an item waiting on a question, a proposal or a research report wants; a parked job\'s pick up wants none', () => {
    for (const waitingOn of ['a question', 'a proposal', 'a research report']) {
      expect(labelsFor({ state: 'needs_you', waitingOn })).toEqual({ allowed: [LABEL_NEEDS_DECISION], add: LABEL_NEEDS_DECISION });
      expect(labelDrift({ state: 'needs_you', waitingOn }, ['hopper', 'hopper:claimed', 'hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: [LABEL_NEEDS_DECISION] });
      expect(labelTakenOff({ state: 'needs_you', waitingOn }, ['hopper', LABEL_NEEDS_DECISION], ['hopper'])).toBeUndefined();
    }
    expect(labelsFor({ state: 'needs_you', waitingOn: 'a person to pick up the parked job' })).toEqual({ allowed: [] });
    expect(labelDrift({ state: 'working' }, ['hopper', LABEL_NEEDS_DECISION])).toEqual({ remove: [LABEL_NEEDS_DECISION], add: [] });
  });

  it('a job parked by itself at a person keeps waiting on the decision; one a person parked waits on its pick up', () => {
    const asked = fold([['job.queued'], ['job.started'], ['proposal.escalated_to_human', {}]]);
    expect(asked).toMatchObject({ state: 'needs_you', waitingOn: 'a proposal' });
    expect(applyEvent(asked, ev('job.parked', { from: 'waiting_answer', auto: true, why: 'its proposal reached the human stage' }), KEY, j1)).toMatchObject({ state: 'needs_you', waitingOn: 'a proposal' });
    expect(applyEvent(asked, ev('job.parked', { from: 'waiting_answer', by: 'someone', via: 'ui' }), KEY, j1)).toMatchObject({ state: 'needs_you', waitingOn: 'a person to pick up the parked job' });
  });
});
