// @vitest-environment happy-dom
// The store's SSE handler (ui/src/store/index.ts onDomainEvent): an event at or below the newest
// seq already held is a replay and changes nothing. A reconnect replays from the page's first
// position, past what the capped live log still holds; a replayed job.started reopened its lane
// span, and the lane timeline then showed the ended job as running (issue #36).
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { laneSpans } from '../../ui/src/model/history.ts';

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
const { CAP, onDomainEvent, useHopper } = (await import(store)) as {
  CAP: { events: number };
  onDomainEvent: (e: DomainEvent) => void;
  useHopper: { getState: () => { events: DomainEvent[]; history: DomainEvent[] }; setState: (s: { events?: DomainEvent[]; history?: DomainEvent[] }) => void };
};

const T0 = Date.parse('2026-10-04T12:00:00Z');
const ev = (seq: number, type: EventType, o: Partial<DomainEvent> = {}): DomainEvent =>
  ({ seq, schemaVersion: 1, id: String(seq), type, at: new Date(T0 + seq * 1000).toISOString(), data: {}, ...o });

describe('onDomainEvent', () => {
  it('a replayed event older than the capped live log is ignored: the ended span stays ended', () => {
    const started = ev(1, 'job.started', { jobId: 'a', laneId: 'm/lane-1' });
    const progress = Array.from({ length: CAP.events + 10 }, (_, i) => ev(2 + i, 'job.progressed', { jobId: 'a' }));
    const finished = ev(CAP.events + 20, 'job.finished', { jobId: 'a', laneId: 'm/lane-1' });
    for (const e of [started, ...progress, finished]) onDomainEvent(e);
    for (const e of [started, ...progress, finished]) onDomainEvent(e); // the reconnect's replay

    const { history, events } = useHopper.getState();
    expect(history.map((e) => e.seq)).toEqual([started.seq, finished.seq]);
    expect(events[0]!.seq).toBe(finished.seq);
    expect(laneSpans(history, 0).map((s) => s.outcome)).toEqual(['finished']);
  });
});

describe('onDomainEvent and the loaded history', () => {
  it('an event the history already holds is not appended twice', () => {
    const finished = ev(10_000, 'job.finished', { jobId: 'b', laneId: 'm/lane-2' });
    useHopper.setState({ events: [ev(9_999, 'job.progressed', { jobId: 'b' })], history: [ev(9_000, 'job.started', { jobId: 'b', laneId: 'm/lane-2' }), finished] });
    onDomainEvent(finished);
    expect(useHopper.getState().history.map((e) => e.seq)).toEqual([9_000, 10_000]);
  });
});
