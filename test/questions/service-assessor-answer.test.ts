// The assessor's own best answer (issue #98): Opus drafts, Fable gives the best answer it can and
// escalates only for a choice that needs the owner; its answer is typed in when it does not, and
// stays on the trail as its recommendation when it does. The trail records the model that ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerDraft, Assessment } from '../../src/domain/ports.ts';
import { PROCEED, SAFE, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const unsure: AnswerDraft = { ...SAFE, confident: false, reason: 'the rules do not say' };
const ESCALATE: Assessment = { escalate: true, reason: 'touches production data' };

describe("the assessor's own answer (Opus, then Fable's best answer, then the owner)", () => {
  const BETTER: Assessment = { answer: 'use sqlite, the rules prefer it', escalate: false, reason: 'the draft missed the rule' };

  it('not escalating with its own answer: that answer is typed into the job, by the assessor', async () => {
    const r = rig({ answer: () => unsure, assess: () => BETTER });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: BETTER.answer, answeredBy: 'fable' });
    expect(got.attempts[1]).toMatchObject({ tier: 'fable', role: 'assessor', answer: BETTER.answer, escalate: false, outcome: 'accepted' });
    expect(r.eventsOf('question.answered')[0]!.data).toMatchObject({ by: 'fable', answer: BETTER.answer });
  });

  it('escalating: its best answer stays on the trail for the owner', async () => {
    const r = rig({ answer: () => unsure, assess: () => ({ ...ESCALATE, answer: 'pick option 1' }) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'open', tier: 'human' });
    expect(got.attempts[1]).toMatchObject({ role: 'assessor', answer: 'pick option 1', escalate: true, outcome: 'escalated' });
  });

  it('an empty answer is malformed: it escalates', async () => {
    const r = rig({ assess: () => ({ ...BETTER, answer: '' }) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'open', tier: 'human' });
    expect(got.attempts[1]).toMatchObject({ role: 'assessor', error: expect.stringContaining('answer') });
  });

  it('the risk rules run on the answer that would be typed', async () => {
    const r = rig({ assess: () => ({ ...BETTER, answer: 'force-push the branch' }) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'open', tier: 'human' });
    expect(got.attempts[1]!.riskRules).toContain('force-push');
  });

  it('the trail records the model each stage reports it ran, over the configured alias', async () => {
    const r = rig({ answer: () => ({ ...SAFE, model: 'claude-opus-9' }), assess: () => ({ ...PROCEED, model: 'claude-fable-9' }) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)!.attempts.map((a) => a.model)).toEqual(['claude-opus-9', 'claude-fable-9']);
  });
});
