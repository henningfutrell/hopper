// The question pipeline after the question left the model stages: the human stage's timers, and
// restart recovery (design.md "Recovery at startup"). Same seams as service.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import { ANSWERED, UP, rig, scriptedLevel, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('human timers', () => {
  it('renotifies every interval, then expires and calls onExpired in the tx', async () => {
    const r = rig({ levels: { opus: () => UP }, renotifyMs: 1000, humanTimeoutMs: 3500 });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    await vi.advanceTimersByTimeAsync(3600);
    const human = r.eventsOf('question.escalated').filter((e) => e.data.target === 'human');
    expect(human.map((e) => [e.data.notifyCount, e.data.renotify])).toEqual([[1, undefined], [2, true], [3, true], [4, true]]);
    expect(r.eventsOf('question.escalated_to_human').map((e) => e.data.notifyCount)).toEqual([1]);
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'expired', notifyCount: 4 });
    expect(r.eventsOf('question.expired')[0]).toMatchObject({ questionId: q.id, data: { questionId: q.id, after_ms: 3500 } });
    expect(r.expired.map((e) => e.depth)).toEqual([1]);
  });

  it('a human answer stops the timers', async () => {
    const r = rig({ levels: { opus: () => UP } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.svc.answerByHuman(q.id, 'ok');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.eventsOf('question.escalated').filter((e) => e.data.target === 'human')).toHaveLength(1);
    expect(r.expired).toHaveLength(0);
  });
});

describe('recover: every open non-human question restarts at the first level', () => {
  it.each(['opus', 'fable', 'some-old-assessor'])('a stored open question at tier %s climbs the levels again from the first', async (tier) => {
    const r = rig();
    const q = r.question();
    r.mem.store.questions.update(q.id, { tier });
    const asked: string[] = [];
    r.setLevels([
      scriptedLevel('opus', (req: AnswerRequest) => { asked.push('opus'); expect(req.question.id).toBe(q.id); return UP; }),
      scriptedLevel('fable', () => { asked.push('fable'); return ANSWERED; }),
    ]);
    r.svc.recover();
    await settle();
    expect(asked).toEqual(['opus', 'fable']);
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answeredBy: 'fable' });
    expect(r.eventsOf('question.escalated').map((e) => e.data.target)).toEqual(['opus', 'fable']);
  });

  it('a question created at the human stage but never escalated (crash before handle) goes to the human', () => {
    const r = rig({ levels: {} });
    const q = r.question();
    r.svc.recover();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ tier: 'human', notifyCount: 1, expiresAt: '2026-10-02T10:00:10.000Z' });
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
  });

  it('an expiry further away than a timer can wait (2^31-1 ms, ~24.8 days) does not fire early', async () => {
    const r = rig({ renotifyMs: 1000, humanTimeoutMs: 2500 });
    const q = r.question();
    const now = Date.now();
    const expiresAt = new Date(now + 40 * 86_400_000).toISOString();
    r.mem.store.questions.update(q.id, {
      tier: 'human', notifyCount: 1, escalatedToHumanAt: new Date(now).toISOString(), lastNotifiedAt: '2099-01-01T00:00:00.000Z', expiresAt,
    });
    r.svc.recover();
    await vi.advanceTimersByTimeAsync(30 * 86_400_000);
    expect(r.mem.store.questions.get(q.id)!.status).toBe('open');
    await vi.advanceTimersByTimeAsync(10 * 86_400_000);
    expect(r.mem.store.questions.get(q.id)!.status).toBe('expired');
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
  });
});
