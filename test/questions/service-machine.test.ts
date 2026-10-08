// The raising machine (issue #485): every event about a question names the machine that raised it —
// the `machineId` subject (and `laneId`, where known) and `raisedBy` in its data — from the question's
// own snapshot, whatever stage, outcome or route the event comes from. A question with no snapshot (one
// asked before the snapshot existed, with nothing to fill it from) emits as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaisedBy } from '../../src/domain/types.ts';
import { UP, rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const DESK: RaisedBy = { machineId: 'desk', name: 'Desk tower', laneId: 'desk/lane-2' };

/** Every question event so far carries the raising machine, as subject and in its data. */
const allCarry = (r: ReturnType<typeof rig>, raisedBy: RaisedBy) => {
  const events = r.mem.events.filter((e) => e.type.startsWith('question.'));
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e, e.type).toMatchObject({ machineId: raisedBy.machineId, data: { raisedBy } });
    if (raisedBy.laneId) expect(e.laneId, e.type).toBe(raisedBy.laneId);
  }
  return events.map((e) => e.type);
};

describe('question events carry the raising machine (issue #485)', () => {
  it('escalated, escalated_to_human and answered (by a human)', async () => {
    const r = rig({ levels: { opus: () => UP } });
    const q = r.question('Which database?', DESK);
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.answerByHuman(q.id, 'sqlite').ok).toBe(true);
    expect(allCarry(r, DESK)).toEqual(['question.escalated', 'question.escalated', 'question.escalated_to_human', 'question.answered']);
  });

  it('answered by a level', async () => {
    const r = rig();
    const q = r.question('Which database?', DESK);
    r.svc.handle(q.id);
    await settle();
    expect(allCarry(r, DESK)).toContain('question.answered');
  });

  it('closed', async () => {
    const r = rig({ levels: {} });
    const q = r.question('Which database?', DESK);
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.closeByHuman(q.id).ok).toBe(true);
    expect(allCarry(r, DESK)).toContain('question.closed');
  });

  it('dismissed', async () => {
    const r = rig({ levels: {} });
    const q = r.question('Which database?', DESK);
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.dismissByHuman(q.id).ok).toBe(true);
    expect(allCarry(r, DESK)).toContain('question.dismissed');
  });

  it('expired', async () => {
    const r = rig({ levels: {}, humanTimeoutMs: 1000, renotifyMs: 60_000 });
    const q = r.question('Which database?', DESK);
    r.svc.handle(q.id);
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    expect(allCarry(r, DESK)).toContain('question.expired');
  });

  it('lapsed', async () => {
    const r = rig({ levels: {} });
    const q = r.question('Allow this command?', DESK);
    r.mem.store.questions.update(q.id, { lapsesAt: new Date(Date.now() + 5000).toISOString() });
    r.svc.handle(q.id);
    await settle();
    expect(r.svc.lapsedInPane(q.id)).toBeDefined();
    expect(allCarry(r, DESK)).toContain('question.lapsed');
  });

  it('a snapshot with no lane: the machine subject alone', async () => {
    const r = rig({ levels: {} });
    const q = r.question('Which database?', { machineId: 'desk' });
    r.svc.handle(q.id);
    await settle();
    r.svc.closeByHuman(q.id);
    for (const e of r.mem.events) expect(e).toMatchObject({ machineId: 'desk', data: { raisedBy: { machineId: 'desk' } } });
    expect(r.mem.events.every((e) => e.laneId === undefined)).toBe(true);
  });

  it('no snapshot: no machine subject and no raisedBy, as before', async () => {
    const r = rig({ levels: {} });
    const q = r.question();
    r.svc.handle(q.id);
    await settle();
    r.svc.closeByHuman(q.id);
    for (const e of r.mem.events) {
      expect(e.machineId).toBeUndefined();
      expect(e.data).not.toHaveProperty('raisedBy');
    }
  });
});
