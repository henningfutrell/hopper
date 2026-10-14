// Auto-answer (issue #632, design.md "Question pipeline"): a level's answer goes into the job with no person when
// auto-answer is on, the level does not escalate and its confidence meets the threshold. The hard limits stay: the
// risk rules and the consequential guard send the question to a person, whatever the level says; a high-priority job
// does only when the user turns that hold on (issue #679).
// A person may correct an auto-answer: the question records what it replaced, and the job gets the correction.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWERED, UP, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const atHuman = (r: ReturnType<typeof rig>, id: string) => {
  const q = r.mem.store.questions.get(id)!;
  expect(q).toMatchObject({ status: 'open', tier: 'human' });
  expect(r.answered).toHaveLength(0);
  return q;
};

describe('the frontier level answers without escalating: the job gets the answer, no person acts', () => {
  it('confidence at the threshold (default high): answered by the level, its confidence on the trail and the event', async () => {
    const r = rig({ levels: { fable: () => ANSWERED } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answer: 'use postgres', answeredBy: 'fable' });
    expect(r.mem.store.questions.get(q.id)!.attempts).toEqual([expect.objectContaining({ tier: 'fable', confidence: 'high', outcome: 'accepted' })]);
    expect(r.eventsOf('question.answered')[0]!.data).toMatchObject({ by: 'fable', answer: 'use postgres', auto: true, confidence: 'high' });
    expect(r.answered).toHaveLength(1);
  });

  it('a lower threshold lets a medium answer through', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, confidence: 'medium' }) } });
    r.mem.store.settings.setAutoAnswer({ enabled: true, threshold: 'medium' });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
  });
});

describe('below the threshold, or auto-answer off: the answer is a recommendation', () => {
  it('the top level is not sure enough: a person gets the question, with the answer on the trail', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, confidence: 'medium' }) } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    expect(got.attempts).toEqual([expect.objectContaining({ tier: 'fable', answer: 'use postgres', confidence: 'medium', outcome: 'escalated' })]);
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toMatch(/fable: medium confidence, below the auto-answer threshold \(high\)/);
  });

  it('a level that gives no confidence meets no threshold', async () => {
    const r = rig({ levels: { fable: () => ({ answer: 'use postgres', escalate: false, reason: 'fine' }) } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    atHuman(r, q.id);
  });

  it('a lower level not sure enough: the question climbs to the next level', async () => {
    const r = rig({ levels: { jr: () => ({ ...ANSWERED, confidence: 'low' }), fable: () => ({ ...ANSWERED, answer: 'use sqlite' }) } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answer: 'use sqlite', answeredBy: 'fable' });
    expect(r.asked.map((a) => a.level)).toEqual(['jr', 'fable']);
  });

  it('auto-answer off: a sure answer still goes to a person', async () => {
    const r = rig({ levels: { fable: () => ANSWERED } });
    r.mem.store.settings.setAutoAnswer({ enabled: false, threshold: 'high' });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    atHuman(r, q.id);
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toMatch(/auto-answer is off/);
  });
});

describe('hard limits: a person answers, whatever the level says', () => {
  it('a risk rule hit', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'yes, deploy it' }) } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(atHuman(r, q.id).attempts[0]).toMatchObject({ riskRules: ['deploy'], outcome: 'escalated' });
  });

  it('the consequential guard: a permissions change', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'yes, grant it' }) } });
    const q = r.question('May I chmod the build directory?');
    r.svc.handle(q.id);
    await settle();
    atHuman(r, q.id);
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toMatch(/consequential: permissions/);
  });

});

describe('a high-priority job (issue #679): only risk and guard cases hold a sure answer', () => {
  it('by default a sure answer on a high-priority job goes into the job, no person', async () => {
    const r = rig({ levels: { fable: () => ANSWERED } });
    const q = r.question();
    r.mem.setJob(q.jobId, { priority: 90 });
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
  });

  it('with "hold high-priority questions for me" on, a person answers', async () => {
    const r = rig({ levels: { fable: () => ANSWERED } });
    r.mem.store.settings.setAutoAnswer({ enabled: true, threshold: 'high', holdHighPriority: true });
    const q = r.question();
    r.mem.setJob(q.jobId, { priority: 90 });
    r.svc.handle(q.id);
    await settle();
    atHuman(r, q.id);
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toMatch(/high priority/);
  });
});

describe('every hold is recorded (issue #679), not only the first', () => {
  it('a risk rule, low confidence and a held high-priority job: all three on the attempt and the event; keptBy the strongest', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Go ahead, rotate the api key', confidence: 'medium' }) } });
    r.mem.store.settings.setAutoAnswer({ enabled: true, threshold: 'high', holdHighPriority: true });
    const q = r.question('May I chmod the build directory?');
    r.mem.setJob(q.jobId, { priority: 90 });
    r.svc.handle(q.id);
    await settle();
    const got = atHuman(r, q.id);
    const holds = [
      { reason: 'guard', by: 'risk', guards: ['credentials'] },
      { reason: 'guard', by: 'guard', guards: ['permissions'] },
      { reason: 'high_priority' },
      { reason: 'low_confidence', confidence: 'medium', threshold: 'high' },
    ];
    expect(got.attempts[0]).toMatchObject({ riskRules: ['credentials'], holds, outcome: 'escalated' });
    expect(got.keptBy).toBe('risk');
    const event = r.eventsOf('question.escalated_to_human')[0]!.data;
    expect(event.holds).toEqual(holds);
    expect(event.reason).toMatch(/risk rules: credentials.*consequential: permissions.*high priority.*medium confidence/);
  });

  it('auto-answer off: no threshold hold beside it', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, confidence: 'low' }) } });
    r.mem.store.settings.setAutoAnswer({ enabled: false, threshold: 'high' });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(atHuman(r, q.id).attempts[0]!.holds).toEqual([{ reason: 'auto_answer_off' }]);
  });

  it('a lower level below the threshold climbs, its hold on its attempt', async () => {
    const r = rig({ levels: { jr: () => ({ ...ANSWERED, confidence: 'low' }), fable: () => ANSWERED } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)!.attempts[0]!.holds).toEqual([{ reason: 'low_confidence', confidence: 'low', threshold: 'high' }]);
  });

  it('"no secrets" in the question is not held by the credentials rule', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Go ahead: it uses no secrets' }) } });
    const q = r.question('This CI step uses no secrets. May I add it?');
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
  });
});

describe('a person corrects an auto-answer', () => {
  async function autoAnswered() {
    const r = rig({ levels: { fable: () => ANSWERED } });
    const q = r.question();
    r.mem.setJob(q.jobId, { status: 'running' });
    r.svc.handle(q.id);
    await settle();
    return { r, q };
  }

  it('the question records what it replaced, a person\'s answer now; the job is told inside the tx', async () => {
    const { r, q } = await autoAnswered();
    const res = r.svc.correct(q.id, 'use sqlite', 'pat');
    expect(res.ok).toBe(true);
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: 'use sqlite', answeredBy: 'human', corrected: { level: 'fable', was: 'use postgres', by: 'pat' } });
    expect(got.attempts.at(-1)).toMatchObject({ tier: 'human', role: 'human', answer: 'use sqlite', reason: 'corrected the auto-answer of fable', outcome: 'accepted' });
    expect(r.eventsOf('question.corrected')[0]!.data).toEqual({ questionId: q.id, level: 'fable', was: 'use postgres', answer: 'use sqlite', by: 'pat' });
    expect(r.corrected).toEqual([{ q: expect.objectContaining({ id: q.id }), depth: 1 }]);
  });

  it('refused: a person\'s own answer, an open question, a corrected one, a job that ended', async () => {
    const { r, q } = await autoAnswered();
    expect(r.svc.correct('nope', 'x', 'pat')).toEqual({ ok: false, reason: 'not_found' });
    const open = r.question('Another?');
    expect(r.svc.correct(open.id, 'x', 'pat')).toEqual({ ok: false, reason: 'not_auto' });
    r.svc.correct(q.id, 'use sqlite', 'pat');
    expect(r.svc.correct(q.id, 'use mysql', 'pat')).toEqual({ ok: false, reason: 'not_auto' });
    const { r: r2, q: q2 } = await autoAnswered();
    r2.mem.setJob(q2.jobId, { status: 'finished' });
    expect(r2.svc.correct(q2.id, 'x', 'pat')).toEqual({ ok: false, reason: 'job_ended' });
    expect(r2.corrected).toHaveLength(0);
  });

  it('an escalating level\'s recommendation a person took is no auto-answer', async () => {
    const r = rig({ levels: { fable: () => UP } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.svc.answerByHuman(q.id, 'use postgres');
    expect(r.svc.correct(q.id, 'x', 'pat')).toEqual({ ok: false, reason: 'not_auto' });
  });
});
