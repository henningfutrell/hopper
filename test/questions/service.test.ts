import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerRequest, AnswerVerdict } from '../../src/domain/ports.ts';
import { SAFE, deferred, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const unsure: AnswerVerdict = { ...SAFE, confident: false, reason: 'unsure' };
const risky: AnswerVerdict = { ...SAFE, risky: true, reason: 'looks scary' };

describe('escalation chain', () => {
  it('accepts a confident, safe opus answer', async () => {
    const r = rig();
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: 'use postgres', answeredBy: 'opus' });
    expect(got.attempts).toHaveLength(1);
    expect(got.attempts[0]).toMatchObject({ tier: 'opus', model: 'opus-m', outcome: 'accepted', reason: expect.any(String) });
    expect(r.eventsOf('question.escalated').map((e) => e.data.target)).toEqual(['opus']);
    expect(r.eventsOf('question.answered')[0]).toMatchObject({
      jobId: q.jobId, questionId: q.id, data: { by: 'opus', answer: 'use postgres' },
    });
    expect(r.answered).toHaveLength(1);
  });

  it.each([
    ['not confident', unsure],
    ['risky', risky],
    ['error', { error: 'boom' }],
    ['risk rule hit', { ...SAFE, answer: 'deploy it to prod' }],
  ])('opus %s: fable answers, with previous attempts', async (_n, verdict) => {
    let seen: AnswerRequest | undefined;
    const r = rig({ opus: () => verdict as AnswerVerdict, fable: (req) => { seen = req; return SAFE; } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answeredBy: 'fable' });
    expect(got.attempts.map((a) => [a.tier, a.outcome])).toEqual([['opus', 'escalated'], ['fable', 'accepted']]);
    expect(seen?.previous).toHaveLength(1);
    expect(r.eventsOf('question.escalated').map((e) => e.data.target)).toEqual(['opus', 'fable']);
    expect(r.eventsOf('question.escalated')[1]!.data.reason).toEqual(expect.any(String));
  });

  it('risk rules are checked over the question text too', async () => {
    const r = rig({ fable: () => unsure });
    const q = r.question('Should I force-push to main?');
    r.svc.handle(q.id);
    await settle();
    const a = r.mem.store.questions.get(q.id)!.attempts[0]!;
    expect(a).toMatchObject({ outcome: 'escalated', riskRules: ['force-push'] });
  });

  it('fable failing goes to the human with the exact event payload', async () => {
    const r = rig({ opus: () => unsure, fable: () => ({ error: 'timeout' }) });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({
      status: 'open', tier: 'human', notifyCount: 1,
      escalatedToHumanAt: '2026-10-02T10:00:00.000Z', lastNotifiedAt: '2026-10-02T10:00:00.000Z',
      expiresAt: '2026-10-02T10:00:10.000Z',
    });
    expect(got.attempts[1]).toMatchObject({ tier: 'fable', outcome: 'escalated', error: 'timeout', model: 'fable-m' });
    const ev = r.eventsOf('question.escalated').at(-1)!;
    expect(ev.jobId).toBe(q.jobId);
    expect(ev.questionId).toBe(q.id);
    expect(ev.data).toEqual({
      questionId: q.id, target: 'human', reason: expect.any(String), text: 'Which database?',
      jobId: q.jobId, goal: 'ship it', answerUrl: `http://localhost/q/${q.id}`, notifyCount: 1,
    });
    expect(r.answered).toHaveLength(0);
  });

  it('feeds rules, job prompt and goal to the answerer; missing rules file is noted', async () => {
    let seen: AnswerRequest | undefined;
    const r = rig({ rules: 'Prefer sqlite.', opus: (req) => { seen = req; return SAFE; } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(seen).toMatchObject({ rules: 'Prefer sqlite.', jobPrompt: 'build the thing', jobGoal: 'ship it', previous: [] });
    const r2 = rig({ rules: null });
    const q2 = r2.question();
    r2.svc.handle(q2.id);
    await settle();
    expect(r2.mem.store.questions.get(q2.id)!.attempts[0]!.reason).toMatch(/rules file missing/);
  });
});

describe('atomicity', () => {
  it('onAnswered runs inside the tx, once', async () => {
    const r = rig();
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.answered.map((a) => a.depth)).toEqual([1]);
    expect(r.eventsOf('question.answered')[0]).toBeDefined();
    expect(r.mem.events.every((e) => e.txDepth === 1)).toBe(true);
  });

  it('a throwing onAnswered rolls the question back', async () => {
    const r = rig();
    const q = r.question();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // replace the service callback via a fresh rig-less service is overkill: poison the job lookup instead
    r.answered.push = () => { throw new Error('engine down'); };
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'open' });
    expect(r.eventsOf('question.answered')).toHaveLength(0);
    err.mockRestore();
  });

  it('human answer while fable is in flight wins; late result logged superseded', async () => {
    const gate = deferred<AnswerVerdict>();
    let fableSignal: AbortSignal | undefined;
    const r = rig({
      opus: () => unsure,
      fable: (_req, signal) => { fableSignal = signal; return gate.promise; },
    });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const res = r.svc.answerByHuman(q.id, 'sqlite');
    expect(res).toMatchObject({ ok: true, question: { status: 'answered', answeredBy: 'human', answer: 'sqlite' } });
    expect(fableSignal?.aborted).toBe(true);
    gate.resolve(SAFE);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: 'sqlite', answeredBy: 'human' });
    expect(got.attempts.map((a) => [a.tier, a.outcome, a.reason])).toEqual([
      ['opus', 'escalated', expect.any(String)],
      ['human', 'accepted', undefined],
      ['fable', 'escalated', 'superseded'],
    ]);
    expect(r.answered).toHaveLength(1);
    expect(r.answered[0]!.depth).toBe(1);
  });

  it('answerByHuman reports not_found and not_open', async () => {
    const r = rig();
    expect(r.svc.answerByHuman('nope', 'x')).toEqual({ ok: false, reason: 'not_found' });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.answerByHuman(q.id, 'x')).toEqual({ ok: false, reason: 'not_open' });
    expect(r.answered).toHaveLength(1);
  });
});

describe('human timers', () => {
  const toHuman = { opus: () => unsure, fable: () => unsure };

  it('renotifies every interval, then expires and calls onExpired in the tx', async () => {
    const r = rig({ ...toHuman, renotifyMs: 1000, humanTimeoutMs: 3500 });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    await vi.advanceTimersByTimeAsync(3600);
    const human = r.eventsOf('question.escalated').filter((e) => e.data.target === 'human');
    expect(human.map((e) => [e.data.notifyCount, e.data.renotify])).toEqual([[1, undefined], [2, true], [3, true], [4, true]]);
    expect(human[1]!.data).toMatchObject({ text: 'Which database?', jobId: q.jobId, answerUrl: `http://localhost/q/${q.id}` });
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'expired', notifyCount: 4 });
    expect(r.eventsOf('question.expired')[0]).toMatchObject({ questionId: q.id, data: { questionId: q.id, after_ms: 3500 } });
    expect(r.expired.map((e) => e.depth)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.eventsOf('question.escalated').filter((e) => e.data.target === 'human')).toHaveLength(4);
  });

  it('a human answer stops the timers', async () => {
    const r = rig({ ...toHuman });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.svc.answerByHuman(q.id, 'ok');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.eventsOf('question.escalated').filter((e) => e.data.target === 'human')).toHaveLength(1);
    expect(r.expired).toHaveLength(0);
  });
});

describe('cancel and stop', () => {
  it('cancel aborts the in-flight tier, clears timers, sets cancelled; late result ignored', async () => {
    const gate = deferred<AnswerVerdict>();
    let sig: AbortSignal | undefined;
    const r = rig({ opus: (_req, signal) => { sig = signal; return gate.promise; } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.mem.store.tx(() => r.svc.cancel(q.id));
    expect(sig?.aborted).toBe(true);
    expect(r.mem.store.questions.get(q.id)!.status).toBe('cancelled');
    gate.resolve(SAFE);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'cancelled' });
    expect(r.answered).toHaveLength(0);
  });

  it('cancel clears the human timers', async () => {
    const r = rig({ opus: () => unsure, fable: () => unsure });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.svc.cancel(q.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.mem.store.questions.get(q.id)!.status).toBe('cancelled');
    expect(r.expired).toHaveLength(0);
    expect(r.eventsOf('question.escalated').filter((e) => e.data.target === 'human')).toHaveLength(1);
  });

  it('stop aborts in-flight tiers without escalating', async () => {
    const gate = deferred<AnswerVerdict>();
    const r = rig({ opus: () => gate.promise });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const stopped = r.svc.stop();
    gate.resolve({ error: 'aborted' } as unknown as AnswerVerdict);
    await stopped;
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'open', tier: 'opus' });
    expect(r.eventsOf('question.escalated').map((e) => e.data.target)).toEqual(['opus']);
  });
});

describe('recover', () => {
  it('re-runs an open opus question', async () => {
    const r = rig();
    const q = r.question();
    r.svc.recover();
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'opus' });
  });

  it('re-runs an open fable question at fable', async () => {
    const r = rig({ opus: () => { throw new Error('must not run'); } });
    const q = r.question();
    r.mem.store.questions.update(q.id, { tier: 'fable' });
    r.svc.recover();
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
  });

  it('re-arms human timers from stored times', async () => {
    const r = rig({ renotifyMs: 1000, humanTimeoutMs: 2500 });
    const q = r.question();
    const now = Date.now();
    r.mem.store.questions.update(q.id, {
      tier: 'human', notifyCount: 1, escalatedToHumanAt: new Date(now - 500).toISOString(),
      lastNotifiedAt: new Date(now - 500).toISOString(), expiresAt: new Date(now + 2000).toISOString(),
    });
    r.svc.recover();
    await vi.advanceTimersByTimeAsync(499);
    expect(r.eventsOf('question.escalated')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(r.eventsOf('question.escalated')[0]!.data).toMatchObject({ renotify: true, notifyCount: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.mem.store.questions.get(q.id)!.status).toBe('expired');
    expect(r.expired).toHaveLength(1);
  });

  it('expires a human question already past expiresAt at once', () => {
    const r = rig();
    const q = r.question();
    r.mem.store.questions.update(q.id, {
      tier: 'human', notifyCount: 1, escalatedToHumanAt: '2026-10-01T00:00:00.000Z',
      lastNotifiedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T09:00:00.000Z',
    });
    r.svc.recover();
    expect(r.mem.store.questions.get(q.id)!.status).toBe('expired');
    expect(r.expired).toHaveLength(1);
    expect(r.eventsOf('question.expired')).toHaveLength(1);
  });
});
