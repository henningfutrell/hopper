// The decider calls view (issue #550): each decision point's settings and its figures over the window, from the
// events — picks, applied, compared, agreed, overridden — and the newest picks with what was decided.
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { DEFAULT_MINOR_DECISION_SETTINGS } from '../../src/domain/types.ts';
import { viewOf } from '../../src/minor-decisions/view.ts';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, jobId = 'j1'): DomainEvent =>
  ({ seq: ++seq, id: `e${seq}`, type, at: `2026-10-09T10:00:${String(seq).padStart(2, '0')}.000Z`, jobId, schemaVersion: 1, data }) as DomainEvent;
const picked = (pickId: string, o: Record<string, unknown> = {}) => ev('minor_decision.picked', {
  pickId, point: 'question-answer', by: 'jev', options: [{ id: '1', label: 'a' }, { id: '2', label: 'b' }], pick: '1', confidence: 0.9,
  mode: 'shadow', threshold: 0.85, applied: false, notApplied: 'shadow', ...o,
});

describe('viewOf', () => {
  it('counts per point and rates agreement over what was compared; an override wins over a comparison', () => {
    const events = [
      picked('p1'), ev('minor_decision.compared', { pickId: 'p1', point: 'question-answer', pick: '1', actual: '1', agreed: true, decidedBy: 'level-1' }),
      picked('p2'), ev('minor_decision.compared', { pickId: 'p2', point: 'question-answer', pick: '1', actual: '2', agreed: false, decidedBy: 'human' }),
      picked('p3', { mode: 'active', applied: true, notApplied: undefined }),
      picked('p4', { pick: undefined, confidence: undefined, error: 'down', notApplied: 'no_pick' }),
      picked('p5'), ev('minor_decision.compared', { pickId: 'p5', point: 'question-answer', pick: '1', actual: '2', agreed: false, decidedBy: 'level-1' }),
      ev('minor_decision.overridden', { pickId: 'p5', point: 'question-answer', pick: '1', actual: '1' }),
      picked('f1', { point: 'failure-assessment', options: [{ id: 'retry', label: 'r' }, { id: 'person', label: 'p' }], pick: 'retry' }),
    ];
    const v = viewOf(events, DEFAULT_MINOR_DECISION_SETTINGS, { available: true }, { set: false });
    expect(v.points[0]).toMatchObject({ point: 'question-answer', asked: 5, picked: 4, applied: 1, compared: 3, agreed: 2, overridden: 1 });
    expect(v.points[0]!.agreement).toBeCloseTo(2 / 3);
    expect(v.points[1]).toMatchObject({ point: 'failure-assessment', asked: 1, picked: 1, compared: 0, agreement: null });
    expect(v.recent.map((p) => p.pickId)).toEqual(['f1', 'p5', 'p4', 'p3', 'p2', 'p1']);
    expect(v.recent[1]).toMatchObject({ actual: '1', agreed: true, overridden: true });
    expect(v.recent[4]).toMatchObject({ actual: '2', agreed: false, decidedBy: 'human' });
  });
});
