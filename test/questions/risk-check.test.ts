// The risk check on a level's answer (issue #679, design.md "Question pipeline"): the Decider makes one typed risk
// decision for every answer a level gives without escalating — `{risk: none|low|real, categories, confidence}`. Active,
// it replaces the keyword risk rules: `real`, or a confidence below the Decider's threshold, holds the question for a
// person, and so does a Decider that fails (fail closed); `none` or `low`, sure enough, lets auto-answer go ahead. In
// shadow, or with no Decider, the keyword risk rules decide (with their negation handling). The guards — delete, send,
// publish, pay, permissions, a gated machine — always hold, whatever the Decider says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionRisk, QuestionRiskInput, QuestionRiskOutcome, RiskDecision } from '../../src/domain/types.ts';
import { ANSWERED, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

/** The Decider's risk call as a double: answers what `decide` says, records every input. */
function decider(decide: (i: QuestionRiskInput) => QuestionRiskOutcome): QuestionRisk & { inputs: QuestionRiskInput[] } {
  const inputs: QuestionRiskInput[] = [];
  return { inputs, risk: async (i) => { inputs.push(i); return decide(i); } };
}
const active = (decision: RiskDecision): QuestionRiskOutcome => ({ asked: true, mode: 'active', threshold: 0.85, decision });
const NONE: RiskDecision = { risk: 'none', categories: [], confidence: 0.95 };
const REAL_CREDENTIALS: RiskDecision = { risk: 'real', categories: ['credentials'], confidence: 0.97 };

const answered = (r: ReturnType<typeof rig>, id: string) => expect(r.mem.store.questions.get(id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
const atHuman = (r: ReturnType<typeof rig>, id: string) => {
  const q = r.mem.store.questions.get(id)!;
  expect(q).toMatchObject({ status: 'open', tier: 'human' });
  return q;
};

describe('no Decider (no key, or the point off): the keyword risk rules decide, and the card says so', () => {
  it('"uses no secrets" gets no credentials risk', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Go ahead: it uses no secrets' }) }, risk: decider(() => ({ asked: false, why: 'Jev is off until a TypeSafe API key is set' })) });
    const q = r.question('This CI step uses no secrets. May I add it?');
    r.svc.handle(q.id);
    await settle();
    answered(r, q.id);
    expect(r.mem.store.questions.get(q.id)!.attempts[0]).toMatchObject({ riskRules: [], riskCheck: { by: 'rules' } });
  });

  it('"rotate the GitHub token" is held by the keyword rules, and the escalation says the rules checked it', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Yes, rotate the access token' }) } });
    const q = r.question('May I rotate the GitHub access token?');
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    expect(got.keptBy).toBe('risk');
    expect(got.escalation).toMatchObject({ reason: 'guard', riskCheck: { by: 'rules' } });
  });
});

describe('the Decider, active: its decision replaces the keyword risk rules', () => {
  it('is asked with the question, the answer, the job goal and what the keyword rules matched', async () => {
    const d = decider(() => active(NONE));
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Go ahead: it uses no secrets' }) }, risk: d });
    const q = r.question('This CI step uses no secrets. May I add it?');
    r.svc.handle(q.id);
    await settle();
    expect(d.inputs).toEqual([{ jobId: r.job.id, questionId: q.id, question: q.text, answer: 'Go ahead: it uses no secrets', level: 'fable', goal: 'ship it', rules: [] }]);
    answered(r, q.id);
    expect(r.mem.store.questions.get(q.id)!.attempts[0]).toMatchObject({ riskCheck: { by: 'decider', decision: NONE }, outcome: 'accepted' });
  });

  it('a keyword hit the Decider sees no risk in is not held: "the secrets are unchanged"', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Yes: the secrets are unchanged' }) }, risk: decider(() => active({ risk: 'low', categories: [], confidence: 0.9 })) });
    const q = r.question('The refactor leaves the secrets as they are. Shall I commit it?');
    r.svc.handle(q.id);
    await settle();
    answered(r, q.id);
    expect(r.mem.store.questions.get(q.id)!.attempts[0]).toMatchObject({ riskRules: ['credentials'] });
  });

  it('"rotate the GitHub token": a real credentials risk holds it, the categories on the hold', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Yes, rotate it' }) }, risk: decider(() => active(REAL_CREDENTIALS)) });
    const q = r.question('May I rotate the GitHub token?');
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    const hold = { reason: 'guard', by: 'risk', decider: { risk: 'real', categories: ['credentials'], confidence: 0.97, threshold: 0.85 } };
    expect(got.attempts[0]).toMatchObject({ holds: [hold], outcome: 'escalated' });
    expect(got).toMatchObject({ keptBy: 'risk', escalation: { reason: 'guard', holds: [hold], riskCheck: { by: 'decider', decision: REAL_CREDENTIALS } } });
    expect(r.eventsOf('question.escalated_to_human')[0]!.data).toMatchObject({ holds: [hold], reason: expect.stringMatching(/Decider: real risk \(credentials\)/) });
  });

  it('a negation that hides a real risk is held: the Decider reads it, not a keyword', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Yes, no need to keep the old one' }) }, risk: decider(() => active({ risk: 'real', categories: ['credentials', 'destructive'], confidence: 0.9 })) });
    const q = r.question('No secrets are stored here except the signing key. May I replace it?');
    r.svc.handle(q.id);
    await settle();
    expect(atHuman(r, q.id).attempts[0]!.holds).toEqual([expect.objectContaining({ by: 'risk', decider: expect.objectContaining({ categories: ['credentials', 'destructive'] }) })]);
  });

  it('not sure enough (below its threshold): held, whatever risk it names', async () => {
    const r = rig({ levels: { fable: () => ANSWERED }, risk: decider(() => active({ risk: 'none', categories: [], confidence: 0.6 })) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(atHuman(r, q.id).attempts[0]!.holds).toEqual([{ reason: 'guard', by: 'risk', decider: { risk: 'none', categories: [], confidence: 0.6, threshold: 0.85 } }]);
  });

  it('a Decider error or timeout holds the question (fail closed), and says why', async () => {
    const r = rig({ levels: { fable: () => ANSWERED }, risk: decider(() => ({ asked: true, mode: 'active', threshold: 0.85, error: 'no pick within 20000 ms' })) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    expect(got.attempts[0]!.holds).toEqual([{ reason: 'guard', by: 'risk', decider: { threshold: 0.85, error: 'no pick within 20000 ms' } }]);
    expect(got.escalation!.riskCheck).toEqual({ by: 'decider', error: 'no pick within 20000 ms' });
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toMatch(/Decider's risk check failed: no pick within 20000 ms/);
  });

  it('the guards always hold: "delete the branch" goes to a person though the Decider sees no risk', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Yes, delete the branch' }) }, risk: decider(() => active(NONE)) });
    const q = r.question('The branch is merged. Shall I delete it?');
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    expect(got.attempts[0]!.holds).toEqual([{ reason: 'guard', by: 'guard', guards: ['delete'] }]);
    expect(got.keptBy).toBe('guard');
  });

  it('a level that escalates is not checked: the Decider is not asked', async () => {
    const d = decider(() => active(NONE));
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, escalate: true }) }, risk: d });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(d.inputs).toHaveLength(0);
  });
});

describe('the Decider in shadow: recorded next to the keyword rules, which decide', () => {
  it('a real risk the rules do not see is recorded, not applied: auto-answer goes ahead', async () => {
    const r = rig({ levels: { fable: () => ANSWERED }, risk: decider(() => ({ asked: true, mode: 'shadow', threshold: 0.85, decision: REAL_CREDENTIALS })) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    answered(r, q.id);
    expect(r.mem.store.questions.get(q.id)!.attempts[0]).toMatchObject({ riskRules: [], riskCheck: { by: 'rules', shadow: true, decision: REAL_CREDENTIALS } });
  });

  it('a Decider error in shadow changes nothing: the rules decide', async () => {
    const r = rig({ levels: { fable: () => ANSWERED }, risk: decider(() => ({ asked: true, mode: 'shadow', threshold: 0.85, error: 'TypeSafe answered 503' })) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    answered(r, q.id);
  });
});
