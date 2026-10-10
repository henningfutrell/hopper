// The decider calls in the UI (issue #550), pure: the agreement rate as a percent, a pick in plain words — what Jev
// picked, how sure, whether it was applied and why not, what was decided —, the mode names, and a pick's event line.
import { describe, expect, it } from 'vitest';
import { environmentNote, keyStatus, MODE_TEXT, pickDecided, pickSummary, pickedEventDetail, rate } from '../../ui/src/model/minor-decisions.ts';

const base = {
  pickId: 'p1', at: '2026-10-09T10:00:00.000Z', point: 'question-answer' as const, options: [{ id: '1', label: 'ledger' }, { id: '2', label: 'journal' }],
  mode: 'shadow' as const, threshold: 0.85, applied: false,
};

describe('decider calls model', () => {
  it('rate: a percent, or a dash with nothing compared', () => {
    expect(rate(null)).toBe('—');
    expect(rate(2 / 3)).toBe('67%');
    expect(rate(1)).toBe('100%');
  });

  it('pickSummary: the option, the confidence and what became of it', () => {
    expect(pickSummary({ ...base, pick: '2', confidence: 0.931, notApplied: 'shadow' })).toBe('journal (2) at 93% — recorded only');
    expect(pickSummary({ ...base, pick: '1', confidence: 0.6, mode: 'active', notApplied: 'below_threshold' })).toBe('ledger (1) at 60% — below the 85% needed');
    expect(pickSummary({ ...base, pick: '1', confidence: 0.99, mode: 'active', notApplied: 'consequential', consequential: ['delete'] })).toBe('ledger (1) at 99% — consequential (delete): never decided by Jev');
    expect(pickSummary({ ...base, pick: '1', confidence: 0.99, mode: 'active', applied: true })).toBe('ledger (1) at 99% — applied');
    expect(pickSummary({ ...base, error: 'TypeSafe answered 503', notApplied: 'no_pick' })).toBe('no pick: TypeSafe answered 503');
  });

  it('pickDecided: what was decided, by whom, and whether Jev agreed', () => {
    expect(pickDecided({ ...base, pick: '1' })).toBe('');
    expect(pickDecided({ ...base, pick: '1', actual: '1', decidedBy: 'level-1', agreed: true })).toBe('level-1 decided ledger (1): agreed');
    expect(pickDecided({ ...base, pick: '1', actual: '2', decidedBy: 'override', agreed: false, overridden: true })).toBe('overridden: journal (2)');
    expect(pickDecided({ ...base, pick: '1', actual: 'something typed', decidedBy: 'human', agreed: false })).toBe('human decided something typed: differed');
  });

  it('mode names in plain words', () => {
    expect(MODE_TEXT).toEqual({ off: 'Off', shadow: 'Shadow: record only', active: 'Active: Jev decides when sure' });
  });

  it('pickedEventDetail: a pick event as one line', () => {
    expect(pickedEventDetail({ point: 'failure-assessment', options: [{ id: 'retry', label: 'Run it again' }, { id: 'person', label: 'Hand it to a person' }], pick: 'retry', confidence: 0.9, mode: 'active', threshold: 0.85, applied: true }))
      .toBe('Jev: Run it again (retry) at 90% — applied');
  });

  it('keyStatus: set or not set, the last 4 characters, and when; never more of the key (issue #657)', () => {
    expect(keyStatus({ set: false })).toBe('Not set');
    expect(keyStatus({ set: true, last4: 'wxyz', setAt: '2026-10-10T15:30:12.000Z', setBy: 'Ada' })).toBe('Set — ends in wxyz — set 2026-10-10 15:30 UTC by Ada');
  });

  it('environmentNote: the variable the key came from, to remove', () => {
    expect(environmentNote({ set: true, last4: 'wxyz' })).toBeUndefined();
    expect(environmentNote({ set: true, last4: 'wxyz', environment: { variable: 'TYPESAFE_API_KEY' } }))
      .toBe('TYPESAFE_API_KEY is still set. The key was imported from it once; the hopper does not read it now. Remove it from the environment.');
  });
});
