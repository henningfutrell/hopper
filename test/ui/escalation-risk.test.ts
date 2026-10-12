// The Decider's risk call on a question card (issue #679): the reason banner names the risk kinds the Decider found, a
// check not sure enough, or a check that failed; a card whose answer the keyword rules checked says so, and how to get a
// better check. The Question gates page shows each level's confidence spread, flagged when most answers fall below the
// threshold.
import { describe, expect, it } from 'vitest';
import type { ConfidenceSpread, Escalation } from '../../src/domain/types.ts';
import { spreadLine } from '../../ui/src/model/auto-answer.ts';
import { reasonSentence, riskCheckNote } from '../../ui/src/model/escalation.ts';

const fable = { by: 'fable', answer: 'Go ahead', confidence: 'high' as const };

describe('the banner: a hold the Decider made', () => {
  it('a real risk: the kinds it found', () => {
    const e: Escalation = { reason: 'guard', holds: [{ reason: 'guard', by: 'risk', decider: { risk: 'real', categories: ['credentials', 'ci'], confidence: 0.97, threshold: 0.85 } }], recommendation: fable };
    expect(reasonSentence(e)).toBe("Sent to you because the Decider found a real risk: credentials, CI. Fable's high-confidence answer is held back on purpose; a person decides.");
  });

  it('not sure enough: how sure, and what it needs', () => {
    const e: Escalation = { reason: 'guard', holds: [{ reason: 'guard', by: 'risk', decider: { risk: 'none', categories: [], confidence: 0.6, threshold: 0.85 } }], recommendation: fable };
    expect(reasonSentence(e)).toMatch(/^Sent to you because the Decider was not sure enough of the risk \(60%, needs 85%\)\./);
  });

  it('the check failed: held to be safe, and why', () => {
    const e: Escalation = { reason: 'guard', holds: [{ reason: 'guard', by: 'risk', decider: { threshold: 0.85, error: 'no pick within 20000 ms' } }], recommendation: fable };
    expect(reasonSentence(e)).toMatch(/^Sent to you because the Decider's risk check failed \(no pick within 20000 ms\), so it is held to be safe\./);
  });

  it('beside other holds: one sentence lists them all', () => {
    const e: Escalation = {
      reason: 'guard', recommendation: { ...fable, confidence: 'medium' },
      holds: [{ reason: 'guard', by: 'risk', decider: { risk: 'real', categories: ['destructive'], confidence: 0.9, threshold: 0.85 } }, { reason: 'low_confidence', confidence: 'medium', threshold: 'high' }],
    };
    expect(reasonSentence(e)).toMatch(/^Sent to you because the Decider found a real risk: destructive and Fable was not confident enough \(medium confidence, needs high\)\./);
  });
});

describe('the risk-check note', () => {
  it('checked by the keyword rules: says so, and how to get a better check', () => {
    expect(riskCheckNote({ reason: 'low_confidence', riskCheck: { by: 'rules' } })).toBe('Risk checked by keyword rules; set up the Decider for better checks.');
  });

  it('the Decider in shadow: the keyword rules decided, the Decider\'s check only recorded', () => {
    expect(riskCheckNote({ reason: 'low_confidence', riskCheck: { by: 'rules', shadow: true, decision: { risk: 'real', categories: ['pay'], confidence: 0.9 } } }))
      .toBe('Risk checked by keyword rules. The Decider, in shadow, says: real risk (pay).');
  });

  it('checked by the Decider, or not checked at all: no note', () => {
    expect(riskCheckNote({ reason: 'guard', riskCheck: { by: 'decider', decision: { risk: 'real', categories: ['pay'], confidence: 0.9 } } })).toBeUndefined();
    expect(riskCheckNote({ reason: 'no_answer' })).toBeUndefined();
    expect(riskCheckNote(undefined)).toBeUndefined();
  });
});

describe('the confidence spread line', () => {
  const s = (over: Partial<ConfidenceSpread>): ConfidenceSpread => ({ level: 'fable', high: 1, medium: 2, low: 0, none: 1, total: 4, below: 3, flagged: true, ...over });

  it('each confidence with its count, and how many fall below the threshold', () => {
    expect(spreadLine(s({}), 'high')).toBe('fable: 1 high · 2 medium · 0 low · 1 none — 3 of 4 below high');
  });
});
