// Auto-answer in the UI (ui/src/model/auto-answer.ts, issue #632): which handled question a level auto-answered — the
// one a person may correct — and the agreement stats as one line.
import { describe, expect, it } from 'vitest';
import type { Question } from '../../src/domain/types.ts';
import { agreementLine, autoAnswerOf } from '../../ui/src/model/auto-answer.ts';

const q = (over: Partial<Question>): Question => ({
  id: 'q1', jobId: 'j1', text: 'Which?', recentOutput: '', detectedBy: 'test', status: 'answered', tier: 'level-1', notifyCount: 0, createdAt: 'a', updatedAt: 'b',
  answer: 'Blue.', answeredBy: 'level-1',
  attempts: [{ tier: 'level-1', role: 'level', startedAt: 'a', answer: 'Blue.', escalate: false, confidence: 'high', outcome: 'accepted' }],
  ...over,
});

describe('autoAnswerOf', () => {
  it('a level\'s answer that went into the job: its level and confidence', () => {
    expect(autoAnswerOf(q({}))).toEqual({ level: 'level-1', confidence: 'high' });
  });

  it.each([
    ['a person\'s answer', q({ answeredBy: 'human', attempts: [{ tier: 'human', role: 'human', startedAt: 'a', answer: 'Blue.', outcome: 'accepted' }] })],
    ['an open question', q({ status: 'open' })],
    ['a corrected one', q({ corrected: { level: 'level-1', was: 'Red.', at: 'c', by: 'admin' } })],
    ['Jev\'s pick', q({ answeredBy: 'jev', attempts: [{ tier: 'jev', role: 'jev', startedAt: 'a', answer: '1', outcome: 'accepted' }] })],
  ])('none for %s', (_n, x) => {
    expect(autoAnswerOf(x)).toBeUndefined();
  });
});

describe('agreementLine', () => {
  it('the auto-answers over the window, the corrected ones, and the share kept', () => {
    expect(agreementLine({ windowDays: 30, answered: 8, corrected: 2, agreement: 0.75 })).toBe('8 auto-answers in 30 days · 2 corrected · 75% kept');
  });

  it('none yet', () => {
    expect(agreementLine({ windowDays: 30, answered: 0, corrected: 0 })).toBe('no auto-answers in 30 days');
  });
});
