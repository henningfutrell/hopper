import { describe, expect, it } from 'vitest';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('jobs', () => {
  it('creates queued, unapproved, attempts 0, and gets it back', () => {
    const s = t.open(t.url());
    const j = s.jobs.create(spec, 50);
    expect(j).toMatchObject({ spec, priority: 50, status: 'queued', approved: false, attempts: 0 });
    expect(j.createdAt).toBe('2026-10-02T10:00:00.000Z');
    expect(s.jobs.get(j.id)).toEqual(j);
    expect(s.jobs.get('nope')).toBeUndefined();
    s.close();
  });

  it('update merges, bumps updatedAt, and clears on explicit undefined', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    const j = s.jobs.create(spec, 50);
    clock.set('2026-10-02T11:00:00.000Z');
    const u = s.jobs.update(j.id, { status: 'held', holdReason: 'budget', result: { a: 1 }, progress: 0.5 });
    expect(u).toMatchObject({ status: 'held', holdReason: 'budget', result: { a: 1 }, progress: 0.5 });
    expect(u.updatedAt).toBe('2026-10-02T11:00:00.000Z');
    const c = s.jobs.update(j.id, { holdReason: undefined, result: undefined });
    expect(c.holdReason).toBeUndefined();
    expect('result' in c && c.result !== undefined).toBe(false);
    expect(c.progress).toBe(0.5);
    s.close();
  });

  it('update of a missing job throws', () => {
    const s = t.open(t.url());
    expect(() => s.jobs.update('nope', { status: 'failed' })).toThrow();
    s.close();
  });

  it('lists newest first with status filter and limit', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock.set(`2026-10-02T10:0${i}:00.000Z`);
      ids.push(s.jobs.create(spec, 50).id);
    }
    s.jobs.update(ids[1]!, { status: 'finished' });
    expect(s.jobs.list().map((j) => j.id)).toEqual([...ids].reverse());
    expect(s.jobs.list({ status: ['queued'] }).map((j) => j.id)).toEqual([ids[3], ids[2], ids[0]]);
    expect(s.jobs.list({ status: ['queued', 'finished'], limit: 2 })).toHaveLength(2);
    s.close();
  });

  it('stores advice, and everything survives reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const j = s.jobs.create(spec, 70);
    const advice = { action: 'chat_only' as const, reason: 'r', details: { x: 1, gatesAsked: true }, source: 'fake', at: 'a' };
    const u = s.jobs.update(j.id, { advice: advice, status: 'finished', result: { ok: [1] }, approved: true });
    s.close();
    const s2 = t.open(path);
    expect(s2.jobs.get(j.id)).toEqual(u);
    s2.close();
  });
});

describe('lanes', () => {
  it('opens the lowest free number per machine, idle, idleSince = openedAt', () => {
    const s = t.open(t.url());
    const a = s.lanes.open('m1');
    const b = s.lanes.open('m1');
    expect(a).toMatchObject({ id: 'm1/lane-1', machineId: 'm1', state: 'idle', openedAt: '2026-10-02T10:00:00.000Z', idleSince: '2026-10-02T10:00:00.000Z' });
    expect(b.id).toBe('m1/lane-2');
    s.lanes.close(a.id);
    expect(s.lanes.open('m1').id).toBe('m1/lane-1');
    expect(s.lanes.open('m2').id).toBe('m2/lane-1');
    s.close();
  });

  it('lists by machine, updates with clear, closes', () => {
    const s = t.open(t.url());
    const a = s.lanes.open('m1');
    s.lanes.open('m2');
    expect(s.lanes.list()).toHaveLength(2);
    expect(s.lanes.list('m1').map((l) => l.id)).toEqual([a.id]);
    const busy = s.lanes.update(a.id, { state: 'busy', jobId: 'j1', idleSince: undefined });
    expect(busy).toMatchObject({ state: 'busy', jobId: 'j1' });
    expect(busy.idleSince).toBeUndefined();
    s.lanes.close(a.id);
    expect(s.lanes.list('m1')).toEqual([]);
    s.close();
  });

  it('survives reopen', () => {
    const path = t.url();
    const s = t.open(path);
    s.lanes.open('m1');
    const l = s.lanes.update(s.lanes.open('m1').id, { state: 'busy', jobId: 'j' });
    s.close();
    const s2 = t.open(path);
    expect(s2.lanes.list('m1')).toHaveLength(2);
    expect(s2.lanes.list('m1').find((x) => x.id === l.id)).toEqual(l);
    s2.close();
  });
});

describe('jobs pulled from a source', () => {
  const ref = (key: string) => ({ source: 'github', kind: 'github', key, url: key, repo: 'o/r', number: 1 });

  it('stores the source and finds the job by key, across reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const j = s.jobs.create(spec, 5, ref('https://x/1'));
    expect(j.source).toEqual(ref('https://x/1'));
    expect(s.jobs.getBySourceKey('https://x/1')).toEqual(j);
    expect(s.jobs.getBySourceKey('nope')).toBeUndefined();
    s.close();
    const s2 = t.open(path);
    expect(s2.jobs.getBySourceKey('https://x/1')).toEqual(j);
    s2.close();
  });

  it('keeps every job for a key; getBySourceKey returns the newest', () => {
    const s = t.open(t.url());
    s.jobs.create(spec, 5, ref('k'));
    const second = s.jobs.create(spec, 5, ref('k'));
    expect(s.jobs.list()).toHaveLength(2);
    expect(s.jobs.getBySourceKey('k')).toEqual(second);
    s.close();
  });

  it('allows many jobs without a source', () => {
    const s = t.open(t.url());
    s.jobs.create(spec, 5);
    s.jobs.create(spec, 5);
    expect(s.jobs.list()).toHaveLength(2);
    expect(s.jobs.list()[0]!.source).toBeUndefined();
    s.close();
  });
});
