// Issue #1169: who answered a question or decided a pick — a person, or a level or Jev with no person — in one line, the
// marker every question form shows.
//
// Feature: the answer source
//   Scenario: a person answered, closed or corrected
//   Scenario: a level answered with no person
//   Scenario: a decider pick: applied by Jev, decided later, or overridden by a person
import { describe, expect, it } from 'vitest';
import { answerSource, pickSource } from '../../ui/src/model/answer-source.ts';

describe('the answer source of a question', () => {
  it('is a person for a human answer, a close or a correction', () => {
    expect(answerSource({ status: 'answered', answeredBy: 'human' })).toEqual({ kind: 'person', line: 'Answered by a person' });
    expect(answerSource({ status: 'closed', answeredBy: 'human' })).toEqual({ kind: 'person', line: 'Closed by a person' });
    expect(answerSource({ status: 'answered', answeredBy: 'human', corrected: { by: 'someone', at: 't', level: 'opus', was: 'x' } }))
      .toEqual({ kind: 'person', line: 'Corrected by a person; opus had answered' });
  });

  it('is auto for a level that answered with no person', () => {
    expect(answerSource({ status: 'answered', answeredBy: 'fable' })).toEqual({ kind: 'auto', line: 'Auto-decided by fable, with no person' });
  });

  it('is none while nobody answered', () => {
    expect(answerSource({ status: 'open' })).toBeUndefined();
    expect(answerSource({ status: 'expired' })).toBeUndefined();
  });
});

describe('the answer source of a decider pick', () => {
  const base = { options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }], pick: 'a', applied: false };

  it('is a person for an override', () => {
    expect(pickSource({ ...base, actual: 'b', overridden: true })).toEqual({ kind: 'person', line: 'Overridden by a person: Second' });
  });

  it('is auto for a pick Jev applied', () => {
    expect(pickSource({ ...base, applied: true })).toEqual({ kind: 'auto', line: 'Auto-decided by Jev: First' });
  });

  it('names who decided later, a person or a level', () => {
    expect(pickSource({ ...base, actual: 'b', decidedBy: 'human' })).toEqual({ kind: 'person', line: 'Decided by a person: Second' });
    expect(pickSource({ ...base, actual: 'a', decidedBy: 'opus' })).toEqual({ kind: 'auto', line: 'Auto-decided by opus: First' });
  });

  it('is none while nothing is decided', () => {
    expect(pickSource(base)).toBeUndefined();
  });
});
