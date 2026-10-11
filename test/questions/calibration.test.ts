// Confidence calibration (issue #679): the confidence each level gave with the answers it did not escalate, over the
// auto-answer window, is on the Question gates page — per level, how many at each confidence and how many fall below the
// threshold —, flagged when most fall below it: the threshold is then seldom met. And the level prompt says what
// confidence an answer the context settles has.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import type { AutoAnswerSettings, Confidence, Question, QuestionAttempt } from '../../src/domain/types.ts';
import { buildLevelPrompt } from '../../src/plugins/escalation-level/claude-cli/prompt.ts';
import { autoAnswerView } from '../../src/questions/auto-answer.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const clock = { now: () => NOW };

const attempt = (tier: string, o: { confidence?: Confidence; escalate?: boolean; at?: string; role?: QuestionAttempt['role'] }): QuestionAttempt => ({
  tier, role: o.role ?? 'level', startedAt: o.at ?? '2026-10-11T10:00:00Z', finishedAt: o.at ?? '2026-10-11T10:00:01Z', answer: 'yes',
  escalate: o.escalate ?? false, ...(o.confidence ? { confidence: o.confidence } : {}), outcome: 'escalated',
});

function storeWith(attempts: QuestionAttempt[][], settings?: AutoAnswerSettings): Pick<UserStore, 'settings' | 'events' | 'questions'> {
  const questions = attempts.map((a, i) => ({ id: `q${i}`, attempts: a, createdAt: a[0]?.startedAt ?? NOW.toISOString() }) as Question);
  return {
    settings: { getAutoAnswer: () => settings },
    events: { between: () => [] },
    questions: { list: () => questions },
  } as unknown as Pick<UserStore, 'settings' | 'events' | 'questions'>;
}

describe('the confidence spread, per level', () => {
  it('counts each level\'s answers that did not escalate by confidence; most below the threshold is flagged', () => {
    const view = autoAnswerView(storeWith([
      [attempt('opus', { confidence: 'high' }), attempt('fable', { confidence: 'medium' })],
      [attempt('fable', { confidence: 'medium' })],
      [attempt('fable', { confidence: 'high' })],
      [attempt('fable', {})],
      // Escalated, a person's answer, and an answer older than the window: not counted.
      [attempt('fable', { confidence: 'low', escalate: true }), attempt('human', { role: 'human' })],
      [attempt('fable', { confidence: 'low', at: '2026-08-01T10:00:00Z' })],
    ]), clock);
    expect(view.calibration).toEqual([
      { level: 'opus', high: 1, medium: 0, low: 0, none: 0, total: 1, below: 0, flagged: false },
      { level: 'fable', high: 1, medium: 2, low: 0, none: 1, total: 4, below: 3, flagged: true },
    ]);
  });

  it('measured against the threshold now: at medium, a medium answer is not below it', () => {
    const view = autoAnswerView(storeWith([[attempt('fable', { confidence: 'medium' })], [attempt('fable', { confidence: 'low' })]], { enabled: true, threshold: 'medium' }), clock);
    expect(view.calibration).toEqual([{ level: 'fable', high: 0, medium: 1, low: 1, none: 0, total: 2, below: 1, flagged: false }]);
  });

  it('no answers: an empty spread', () => {
    expect(autoAnswerView(storeWith([]), clock).calibration).toEqual([]);
  });
});

describe('the level prompt calibrates confidence', () => {
  it('an answer the context settles, not escalated, is high confidence', () => {
    const prompt = buildLevelPrompt({
      question: { id: 'q1', text: 'Which?', recentOutput: '' }, jobPrompt: 'p', rules: '', previous: [], level: { number: 1, of: 1, name: 'fable' },
    } as unknown as Parameters<typeof buildLevelPrompt>[0]);
    expect(prompt).toMatch(/settle the question and you do not escalate, your confidence is "high"/);
    expect(prompt).toMatch(/Do not lower your confidence only because a person could also be asked/);
  });
});
