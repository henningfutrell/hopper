// The owner's other two moves on a question (design.md "Dismiss", "Seen"): dismiss drops it with
// no answer and hands it to onDismissed inside the tx; seen stamps seenAt once. Same rig as
// service.test.ts: doubles at the Answerer / Assessor seams, the in-memory Store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assessment } from '../../src/domain/ports.ts';
import { PROCEED, deferred, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('dismiss and seen', () => {
  it('dismissByHuman while the assessor is in flight wins: question dismissed with no answer, the stage aborted, question.dismissed, onDismissed inside the tx', async () => {
    const gate = deferred<Assessment>();
    let sig: AbortSignal | undefined;
    const r = rig({ assess: (_req, _d, signal) => { sig = signal; return gate.promise; } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    const res = r.svc.dismissByHuman(q.id);
    expect(res).toMatchObject({ ok: true, question: { status: 'dismissed' } });
    expect(sig?.aborted).toBe(true);
    gate.resolve(PROCEED);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got.status).toBe('dismissed');
    expect(got.answer).toBeUndefined();
    expect(r.eventsOf('question.dismissed').map((e) => e.data)).toEqual([{ questionId: q.id }]);
    expect(r.eventsOf('question.answered')).toHaveLength(0);
    expect(r.answered).toHaveLength(0);
    expect(r.dismissed.map((x) => [x.q.status, x.depth])).toEqual([['dismissed', 1]]);
    expect(r.svc.dismissByHuman(q.id)).toEqual({ ok: false, reason: 'not_open' });
    expect(r.svc.dismissByHuman('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a dismissed human question is never re-notified nor expired', async () => {
    const r = rig({ answer: null, renotifyMs: 1000, humanTimeoutMs: 5000 });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.dismissByHuman(q.id).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.eventsOf('question.escalated').filter((e) => e.data.renotify)).toHaveLength(0);
    expect(r.expired).toHaveLength(0);
  });

  it('markSeen sets seenAt once and keeps it; not_found for an unknown question', async () => {
    const r = rig({ answer: null });
    const q = r.question();
    const first = r.svc.markSeen(q.id);
    expect(first).toMatchObject({ ok: true, question: { seenAt: '2026-10-02T10:00:00.000Z' } });
    vi.setSystemTime(new Date('2026-10-02T11:00:00Z'));
    expect(r.svc.markSeen(q.id)).toMatchObject({ ok: true, question: { seenAt: '2026-10-02T10:00:00.000Z' } });
    expect(r.svc.markSeen('nope')).toEqual({ ok: false, reason: 'not_found' });
  });
});
