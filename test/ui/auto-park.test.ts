// Auto-park in the UI (ui/src/model/auto-park.ts, issues #650, #2335), pure: whether the answer to a parked job's question
// picks it up by itself (an auto-parked job) or the person picks it up after it.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { answerPicksUp } from '../../ui/src/model/auto-park.ts';

describe('auto-park model', () => {
  it('the answer picks up a job auto-park parked; one a person parked waits for its pick up', () => {
    const job = (parked: Job['parked']) => ({ status: 'parked', parked }) as Job;
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer', auto: true, why: 'Parked automatically: a job that waits on a person holds no agent.' }))).toBe(true);
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer' }))).toBe(false);
  });
});
