// Auto-park in the UI (ui/src/model/auto-park.ts, issues #650, #2335), pure: whether the answer to a parked job's question
// picks it up by itself (an auto-parked job) or the person picks it up after it; what it waits on a person for, and
// whether Pick up is refused (issue #2415).
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { answerPicksUp, personWait, pickUpRefused } from '../../ui/src/model/auto-park.ts';

describe('auto-park model', () => {
  it('the answer picks up a job auto-park parked; one a person parked waits for its pick up', () => {
    const job = (parked: Job['parked']) => ({ status: 'parked', parked }) as Job;
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer', auto: true, why: 'Parked automatically: a job that waits on a person holds no agent.' }))).toBe(true);
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer' }))).toBe(false);
  });

  it('a question with a person, or an item at the human stage, is a person wait; one at a level is not (issue #2415)', () => {
    expect(personWait({ tier: 'human' }, undefined)).toBe('question');
    expect(personWait({ tier: 'frontier' }, { kind: 'proposal', stage: 'human' })).toBeUndefined();
    expect(personWait(undefined, { kind: 'proposal', stage: 'human' })).toBe('proposal');
    expect(personWait(undefined, { kind: 'research', stage: 'frontier' })).toBeUndefined();
    expect(personWait(undefined, undefined)).toBeUndefined();
  });

  it('Pick up is refused only for a job auto-park parked on a person with no answer kept (issue #2415)', () => {
    const auto = { at: 'a', from: 'waiting_answer', auto: true, why: 'w' } as const;
    expect(pickUpRefused({ parked: auto }, 'question')).toBe(true);
    expect(pickUpRefused({ parked: auto }, 'proposal')).toBe(true);
    expect(pickUpRefused({ parked: auto, pendingAnswer: 'Blue.' }, 'question')).toBe(false);
    expect(pickUpRefused({ parked: { at: 'a', from: 'waiting_answer' } }, 'question')).toBe(false);
    expect(pickUpRefused({ parked: auto }, undefined)).toBe(false);
  });
});
