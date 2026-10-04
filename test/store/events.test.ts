import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { EVENT_SCHEMA_VERSIONS } from '../../src/domain/types.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const ev = (type: 'job.queued' | 'lane.opened' = 'job.queued', n = 0) => ({ type, jobId: 'j', data: { n } });

describe('event log', () => {
  it('assigns seq, id, at; since and recent behave', () => {
    const s = t.open(t.url());
    const a = s.events.append(ev());
    const b = s.events.append(ev('lane.opened', 1));
    const c = s.events.append({ ...ev(), at: '2020-01-01T00:00:00.000Z' });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.at).toBe('2026-10-02T10:00:00.000Z');
    expect(c.at).toBe('2020-01-01T00:00:00.000Z');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(s.events.since(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(s.events.since(0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(s.events.recent().map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(s.events.recent(10, ['lane.opened'])).toEqual([b]);
    expect(s.events.recent(1)).toEqual([c]);
    s.close();
  });

  it('keeps optional ids and data; seq is monotonic across reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const a = s.events.append({ type: 'decision.made', decisionId: 'd', laneId: 'l', machineId: 'm', data: { k: [1] } });
    s.close();
    const s2 = t.open(path);
    expect(s2.events.since(0)).toEqual([a]);
    expect(s2.events.append(ev()).seq).toBe(2);
    s2.close();
  });

  it('notifies immediately outside a tx, and unsubscribe stops it', () => {
    const s = t.open(t.url());
    const got: DomainEvent[] = [];
    const off = s.events.subscribe((e) => got.push(e));
    s.events.append(ev());
    off();
    s.events.append(ev());
    expect(got.map((e) => e.seq)).toEqual([1]);
    s.close();
  });

  it('notifies only after the outermost commit, in seq order', () => {
    const s = t.open(t.url());
    const got: number[] = [];
    s.events.subscribe((e) => got.push(e.seq));
    s.tx(() => {
      s.events.append(ev());
      s.tx(() => { s.events.append(ev()); });
      expect(got).toEqual([]);
      s.events.append(ev());
    });
    expect(got).toEqual([1, 2, 3]);
    s.close();
  });

  it('notifies nothing on rollback and reuses no state', () => {
    const s = t.open(t.url());
    const got: number[] = [];
    s.events.subscribe((e) => got.push(e.seq));
    expect(() => s.tx(() => { s.events.append(ev()); throw new Error('boom'); })).toThrow('boom');
    expect(got).toEqual([]);
    expect(s.events.since(0)).toEqual([]);
    s.events.append(ev());
    expect(got).toEqual([1]);
    s.close();
  });

  it('an inner throw caught by the outer still commits the outer', () => {
    const s = t.open(t.url());
    expect(() => s.tx(() => { s.tx(() => { throw new Error('inner'); }); })).toThrow('inner');
    expect(s.tx(() => 7)).toBe(7);
    s.close();
  });

  it('a throwing listener is reported and never breaks append or other listeners', () => {
    const s = t.open(t.url());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: number[] = [];
    s.events.subscribe(() => { throw new Error('bad listener'); });
    s.events.subscribe((e) => got.push(e.seq));
    expect(s.events.append(ev()).seq).toBe(1);
    expect(got).toEqual([1]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    s.close();
  });
});

describe('tx', () => {
  it('commits writes of every repository together and rolls them back together', () => {
    const s = t.open(t.url());
    expect(() => s.tx(() => { s.jobs.create({ executor: 'x', payload: {} }, 1); s.lanes.open('m'); throw new Error('x'); })).toThrow();
    expect(s.jobs.list()).toEqual([]);
    expect(s.lanes.list()).toEqual([]);
    s.tx(() => s.tx(() => { s.jobs.create({ executor: 'x', payload: {} }, 1); }));
    expect(s.jobs.list()).toHaveLength(1);
    s.close();
  });
});

describe('event schema version', () => {
  it('is stamped from EVENT_SCHEMA_VERSIONS, round-trips, survives reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const a = s.events.append(ev());
    expect(a.schemaVersion).toBe(EVENT_SCHEMA_VERSIONS['job.queued']);
    expect(s.events.since(0)[0]!.schemaVersion).toBe(a.schemaVersion);
    s.close();
    const s2 = t.open(path);
    expect(s2.events.recent(1)).toEqual([a]);
    s2.close();
  });

  it('notifies listeners with the stamped version', () => {
    const s = t.open(t.url());
    const seen: number[] = [];
    s.events.subscribe((e) => seen.push(e.schemaVersion));
    s.events.append(ev());
    expect(seen).toEqual([1]);
    s.close();
  });
});
