import { describe, expect, it } from 'vitest';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const input = (jobId: string, text = 'proceed?', tier = 'opus') => ({ jobId, text, recentOutput: 'tail', detectedBy: 'marker', tier });

describe('questions repository', () => {
  it('creates an open question at the stage it is given (the first escalation level instance, or human), empty trail, from the store clock and idGen', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 5);
    const q = s.questions.create(input(j.id));
    expect(q).toMatchObject({
      jobId: j.id, text: 'proceed?', recentOutput: 'tail', detectedBy: 'marker',
      status: 'open', tier: 'opus', attempts: [], notifyCount: 0,
      createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(q.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.questions.get(q.id)).toEqual(q);
    expect(s.questions.get('nope')).toBeUndefined();
    expect(s.questions.create(input(j.id, 'no levels', 'human')).tier).toBe('human');
    expect(s.questions.create(input(j.id, 'renamed', 'sonnet')).tier).toBe('sonnet');
    s.close();
  });

  it('lists newest first and filters by status, jobId and limit', () => {
    const s = t.open(t.url());
    const a = s.jobs.create(spec, 5);
    const b = s.jobs.create(spec, 5);
    const q1 = s.questions.create(input(a.id, 'one'));
    const q2 = s.questions.create(input(b.id, 'two'));
    const q3 = s.questions.create(input(a.id, 'three'));
    s.questions.update(q2.id, { status: 'answered' });
    expect(s.questions.list().map((q) => q.id)).toEqual([q3.id, q2.id, q1.id]);
    expect(s.questions.list({ status: ['open'] }).map((q) => q.id)).toEqual([q3.id, q1.id]);
    expect(s.questions.list({ status: ['answered', 'expired'] }).map((q) => q.id)).toEqual([q2.id]);
    expect(s.questions.list({ jobId: a.id }).map((q) => q.id)).toEqual([q3.id, q1.id]);
    expect(s.questions.list({ limit: 2 }).map((q) => q.id)).toEqual([q3.id, q2.id]);
    expect(s.questions.list({ status: ['open'], jobId: b.id })).toEqual([]);
    s.close();
  });

  it('update merges, clears on undefined, bumps updatedAt, and keeps status filterable', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    const q = s.questions.create(input(s.jobs.create(spec, 5).id));
    clock.set('2026-10-02T11:00:00.000Z');
    const u = s.questions.update(q.id, { tier: 'human', expiresAt: 'x', notifyCount: 2 });
    expect(u).toMatchObject({ tier: 'human', expiresAt: 'x', notifyCount: 2, updatedAt: '2026-10-02T11:00:00.000Z', createdAt: q.createdAt });
    const c = s.questions.update(q.id, { expiresAt: undefined, status: 'cancelled' });
    expect('expiresAt' in c).toBe(false);
    expect(s.questions.list({ status: ['cancelled'] })).toHaveLength(1);
    expect(s.questions.list({ status: ['open'] })).toHaveLength(0);
    expect(() => s.questions.update('nope', {})).toThrow(/question not found/);
    s.close();
  });

  it('addAttempt appends in order and bumps updatedAt', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    const q = s.questions.create(input(s.jobs.create(spec, 5).id));
    clock.set('2026-10-02T12:00:00.000Z');
    s.questions.addAttempt(q.id, { tier: 'opus', role: 'level', startedAt: 'a', outcome: 'escalated', reason: 'unsure' });
    const r = s.questions.addAttempt(q.id, { tier: 'fable', role: 'level', startedAt: 'b', outcome: 'accepted', answer: 'yes' });
    expect(r.attempts.map((a) => a.tier)).toEqual(['opus', 'fable']);
    expect(r.updatedAt).toBe('2026-10-02T12:00:00.000Z');
    expect(() => s.questions.addAttempt('nope', { tier: 'opus', role: 'level', startedAt: 'a', outcome: 'accepted' })).toThrow(/question not found/);
    s.close();
  });

  it('survives close and reopen, and rolls back with the transaction', () => {
    const path = t.url();
    const s = t.open(path);
    const j = s.jobs.create(spec, 5);
    const q = s.questions.create(input(j.id));
    s.questions.addAttempt(q.id, { tier: 'opus', role: 'level', startedAt: 'a', outcome: 'escalated' });
    expect(() => s.tx(() => { s.questions.update(q.id, { status: 'answered' }); throw new Error('boom'); })).toThrow('boom');
    expect(s.questions.get(q.id)?.status).toBe('open');
    const before = s.questions.get(q.id);
    s.close();
    const s2 = t.open(path);
    expect(s2.questions.get(q.id)).toEqual(before);
    expect(s2.questions.list({ jobId: j.id })).toHaveLength(1);
    s2.close();
  });

  it('event questionId round-trips through append, since, recent and reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const e = s.events.append({ type: 'job.queued', jobId: 'j', questionId: 'q1', data: {} });
    const plain = s.events.append({ type: 'job.queued', data: {} });
    expect(s.events.since(0)[0]?.questionId).toBe('q1');
    expect('questionId' in s.events.since(0)[1]!).toBe(false);
    expect(s.events.recent(10)[1]).toEqual(e);
    s.close();
    const s2 = t.open(path);
    expect(s2.events.since(0).map((x) => x.questionId)).toEqual(['q1', undefined]);
    expect(plain.seq).toBe(2);
    s2.close();
  });
});
