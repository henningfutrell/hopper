// Auto-park in the UI (ui/src/model/auto-park.ts, issue #650), pure: the summary of the timeouts, the change a save sends
// — only what differs, refused when a value is not a number of minutes —, and whether the answer to a parked job's
// question picks it up by itself (an auto-parked job) or the person picks it up after it.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { answerPicksUp, autoParkPatch, autoParkSummary } from '../../ui/src/model/auto-park.ts';

describe('auto-park model', () => {
  it('the summary says what is on, per kind of job', () => {
    expect(autoParkSummary({ minutes: 30, highPriorityMinutes: 30 })).toBe('A job parks by itself when its question waits on a person for 30 min.');
    expect(autoParkSummary({ minutes: 30, highPriorityMinutes: 10 })).toBe('A job parks by itself when its question waits on a person for 30 min; a high-priority job after 10 min.');
    expect(autoParkSummary({ minutes: 0, highPriorityMinutes: 10 })).toBe('Only a high-priority job parks by itself, when its question waits on a person for 10 min.');
    expect(autoParkSummary({ minutes: 45, highPriorityMinutes: 0 })).toBe('A job parks by itself when its question waits on a person for 45 min; a high-priority job never does.');
    expect(autoParkSummary({ minutes: 0, highPriorityMinutes: 0 })).toBe('Off: no job parks by itself.');
  });

  it('a save sends only what differs; a value that is not a number of minutes is refused', () => {
    const s = { minutes: 30, highPriorityMinutes: 30 };
    expect(autoParkPatch(s, { minutes: '30', highPriorityMinutes: '30' })).toEqual({ ok: true, patch: undefined });
    expect(autoParkPatch(s, { minutes: '0', highPriorityMinutes: '30' })).toEqual({ ok: true, patch: { minutes: 0 } });
    expect(autoParkPatch(s, { minutes: '60', highPriorityMinutes: ' 5 ' })).toEqual({ ok: true, patch: { minutes: 60, highPriorityMinutes: 5 } });
    expect(autoParkPatch(s, { minutes: '', highPriorityMinutes: '30' })).toEqual({ ok: false, error: 'Minutes: a number from 0 to 10080' });
    expect(autoParkPatch(s, { minutes: '30', highPriorityMinutes: '-1' })).toEqual({ ok: false, error: 'High-priority minutes: a number from 0 to 10080' });
    expect(autoParkPatch(s, { minutes: 'soon', highPriorityMinutes: '30' }).ok).toBe(false);
  });

  it('the answer picks up a job auto-park parked; one a person parked waits for its pick up', () => {
    const job = (parked: Job['parked']) => ({ status: 'parked', parked }) as Job;
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer', auto: true, why: 'Parked automatically: the question waited 30 min.' }))).toBe(true);
    expect(answerPicksUp(job({ at: 'a', from: 'waiting_answer' }))).toBe(false);
  });
});
