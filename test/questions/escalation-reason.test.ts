// Why a question came to a person (issue #679): a typed field on the question, set when it reaches the human stage —
// the reason, the guards that held a sure answer back, and what the level that held it recommended.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWERED, UP, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

async function escalationOf(r: ReturnType<typeof rig>, text?: string) {
  const q = r.question(text);
  r.svc.handle(q.id);
  await settle();
  const got = r.mem.store.questions.get(q.id)!;
  expect(got).toMatchObject({ status: 'open', tier: 'human' });
  return got.escalation;
}

describe('the escalation reason', () => {
  it('a risk rule held a sure answer: guard, the rule named and described, the level\'s answer as the recommendation', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'Go ahead and rotate the api key' }) } });
    expect(await escalationOf(r, 'May I change CI?')).toEqual({
      reason: 'guard',
      guards: [{ name: 'credentials', describe: 'credentials, secrets, passwords, keys or tokens' }],
      recommendation: { by: 'fable', answer: 'Go ahead and rotate the api key', confidence: 'high' },
    });
  });

  it('the consequential guard: guard, permissions named', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, answer: 'yes' }) } });
    expect(await escalationOf(r, 'May I chmod the build directory?')).toMatchObject({
      reason: 'guard', guards: [{ name: 'permissions', describe: expect.stringMatching(/permissions/) }], recommendation: { by: 'fable', answer: 'yes' },
    });
  });

  it('the top level not sure enough: low_confidence', async () => {
    const r = rig({ levels: { fable: () => ({ ...ANSWERED, confidence: 'medium' }) } });
    expect(await escalationOf(r)).toEqual({ reason: 'low_confidence', recommendation: { by: 'fable', answer: 'use postgres', confidence: 'medium' } });
  });

  it('the top level sent it up: frontier_escalated, its recommendation kept', async () => {
    const r = rig({ levels: { fable: () => UP } });
    expect(await escalationOf(r)).toEqual({ reason: 'frontier_escalated', recommendation: { by: 'fable', answer: 'maybe postgres' } });
  });

  it('the top level failed, or no levels: no_answer', async () => {
    expect(await escalationOf(rig({ levels: { fable: () => { throw new Error('down'); } } }))).toEqual({ reason: 'no_answer' });
    expect(await escalationOf(rig({ levels: {} }))).toEqual({ reason: 'no_answer' });
  });

  it('a lower level\'s answer stays the recommendation when the top level fails', async () => {
    const r = rig({ levels: { jr: () => ({ ...ANSWERED, confidence: 'low' }), fable: () => ({ nope: true }) } });
    expect(await escalationOf(r)).toEqual({ reason: 'no_answer', recommendation: { by: 'jr', answer: 'use postgres', confidence: 'low' } });
  });

  it('auto-answer off and a high-priority job have their own reasons', async () => {
    const off = rig({ levels: { fable: () => ANSWERED } });
    off.mem.store.settings.setAutoAnswer({ enabled: false, threshold: 'high' });
    expect(await escalationOf(off)).toMatchObject({ reason: 'auto_answer_off' });
    const high = rig({ levels: { fable: () => ANSWERED } });
    const q = high.question();
    high.mem.setJob(q.jobId, { priority: 90 });
    high.svc.handle(q.id);
    await settle();
    expect(high.mem.store.questions.get(q.id)!.escalation).toMatchObject({ reason: 'high_priority', recommendation: { by: 'fable' } });
  });

  it('the attempt reasons no longer say "(no rules yet)"', async () => {
    const r = rig({ rules: null, levels: { fable: () => UP } });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)!.attempts[0]!.reason).toBe(UP.reason);
  });
});
