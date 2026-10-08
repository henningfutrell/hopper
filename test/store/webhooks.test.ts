import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const input = { name: 'hook', url: 'http://127.0.0.1:9/h', events: ['*'], active: true };

// The table is the source of truth for webhook subscriptions (issue #78): rows are added, changed and
// removed one by one, never reconciled from a document.
describe('webhook subscriptions', () => {
  it('creates active, gets, lists, deletes', () => {
    const s = t.open(t.url());
    const w = s.webhooks.add(input)!;
    expect(w).toMatchObject({ ...input, active: true, createdAt: '2026-10-02T10:00:00.000Z' });
    expect(s.webhooks.get(w.id)).toEqual(w);
    expect(s.webhooks.list()).toEqual([w]);
    expect(s.webhooks.delete(w.id)).toBe(true);
    expect(s.webhooks.delete(w.id)).toBe(false);
    expect(s.webhooks.get(w.id)).toBeUndefined();
    expect(s.webhooks.list()).toEqual([]);
    s.close();
  });
});

describe('webhook add and update', () => {
  it('add refuses a name already there: undefined, the row as it was', () => {
    const s = t.open(t.url());
    const a = s.webhooks.add(input)!;
    expect(s.webhooks.add({ ...input, url: 'http://127.0.0.1:9/new' })).toBeUndefined();
    expect(s.webhooks.list()).toEqual([a]);
    const c = s.webhooks.add({ ...input, name: 'second' })!;
    expect(c.id).not.toBe(a.id);
    expect(s.webhooks.list()).toEqual([a, c]);
    s.close();
  });

  it('update changes only the fields given, keeping id, name, the secret and createdAt', () => {
    const s = t.open(t.url());
    const a = s.webhooks.add(input)!;
    const b = s.webhooks.update(a.id, { active: false });
    expect(b).toEqual({ ...a, active: false });
    const c = s.webhooks.update(a.id, { url: 'http://127.0.0.1:9/new', events: ['job.failed'] });
    expect(c).toEqual({ ...a, active: false, url: 'http://127.0.0.1:9/new', events: ['job.failed'] });
    expect(s.webhooks.get(a.id)).toEqual(c);
    expect(s.webhooks.update('nope', { active: true })).toBeUndefined();
    s.close();
  });
});

// Issue #451: the signing secret is kept sealed in its own column; the subscription the store answers
// never carries it, only when it last changed.
describe('webhook signing secret', () => {
  it('setSecret keeps the sealed text and when; sealedSecret reads it; the subscription carries neither', () => {
    const clock = fixedClock();
    const s = t.open(t.url(), clock);
    const w = s.webhooks.add(input)!;
    expect(s.webhooks.sealedSecret(w.id)).toBeUndefined();
    expect(w.secretChangedAt).toBeUndefined();
    clock.set('2026-10-02T11:00:00.000Z');
    const after = s.webhooks.setSecret(w.id, 'hs1.sealed-text')!;
    expect(after).toEqual({ ...w, secretChangedAt: '2026-10-02T11:00:00.000Z' });
    expect(JSON.stringify(s.webhooks.list())).not.toContain('sealed-text');
    expect(s.webhooks.sealedSecret(w.id)).toBe('hs1.sealed-text');
    expect(s.webhooks.setSecret('nope', 'x')).toBeUndefined();
    s.close();
  });
});

describe('webhook deliveries', () => {
  function setup(path = t.url(), clock = fixedClock()) {
    const s = t.open(path, clock);
    const w = s.webhooks.add(input)!;
    const e: DomainEvent = s.events.append({ type: 'job.queued', jobId: 'j', data: {} });
    return { s, w, e, clock, path };
  }

  it('createDelivery is pending, attempts 0, due now', () => {
    const { s, w, e } = setup();
    const d = s.webhooks.createDelivery(w.id, e);
    expect(d).toMatchObject({ subscriptionId: w.id, eventSeq: e.seq, eventType: 'job.queued', status: 'pending', attempts: 0, nextAttemptAt: '2026-10-02T10:00:00.000Z' });
    s.close();
  });

  it('updateDelivery patches and clears; dueDeliveries respects status and time', () => {
    const { s, w, e, clock } = setup();
    const d1 = s.webhooks.createDelivery(w.id, e);
    const d2 = s.webhooks.createDelivery(w.id, e);
    const d3 = s.webhooks.createDelivery(w.id, e);
    clock.set('2026-10-02T10:00:05.000Z');
    s.webhooks.updateDelivery(d1.id, { status: 'retrying', attempts: 1, lastStatusCode: 500, lastError: 'x', nextAttemptAt: '2026-10-02T10:01:00.000Z' });
    s.webhooks.updateDelivery(d2.id, { status: 'delivered' });
    const now = new Date('2026-10-02T10:00:30.000Z');
    expect(s.webhooks.dueDeliveries(now).map((d) => d.id)).toEqual([d3.id]);
    expect(s.webhooks.dueDeliveries(new Date('2026-10-02T10:01:00.000Z')).map((d) => d.id).sort()).toEqual([d1.id, d3.id].sort());
    const cleared = s.webhooks.updateDelivery(d1.id, { lastError: undefined, lastStatusCode: undefined });
    expect(cleared.lastError).toBeUndefined();
    expect(cleared.lastStatusCode).toBeUndefined();
    expect(cleared.updatedAt).toBe('2026-10-02T10:00:05.000Z');
    s.close();
  });

  it('lists newest first, filtered by subscription, with limit', () => {
    const { s, w, e, clock } = setup();
    const w2 = s.webhooks.add({ ...input, name: 'other' })!;
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) { clock.set(`2026-10-02T10:0${i}:00.000Z`); ids.push(s.webhooks.createDelivery(w.id, e).id); }
    clock.set('2026-10-02T10:09:00.000Z');
    const other = s.webhooks.createDelivery(w2.id, e);
    expect(s.webhooks.listDeliveries().map((d) => d.id)).toEqual([other.id, ...[...ids].reverse()]);
    expect(s.webhooks.listDeliveries({ subscriptionId: w.id }).map((d) => d.id)).toEqual([...ids].reverse());
    expect(s.webhooks.listDeliveries({ subscriptionId: w.id, limit: 1 }).map((d) => d.id)).toEqual([ids[2]]);
    s.close();
  });

  it('deleting a subscription fails its pending and retrying deliveries only', () => {
    const { s, w, e } = setup();
    const pending = s.webhooks.createDelivery(w.id, e);
    const retrying = s.webhooks.createDelivery(w.id, e);
    const done = s.webhooks.createDelivery(w.id, e);
    s.webhooks.updateDelivery(retrying.id, { status: 'retrying' });
    s.webhooks.updateDelivery(done.id, { status: 'delivered' });
    s.webhooks.delete(w.id);
    const by = Object.fromEntries(s.webhooks.listDeliveries().map((d) => [d.id, d.status]));
    expect(by).toEqual({ [pending.id]: 'failed', [retrying.id]: 'failed', [done.id]: 'delivered' });
    expect(s.webhooks.dueDeliveries(new Date('2030-01-01'))).toEqual([]);
    s.close();
  });

  it('subscriptions and deliveries survive reopen', () => {
    const { s, w, e, path } = setup();
    const d = s.webhooks.updateDelivery(s.webhooks.createDelivery(w.id, e).id, { status: 'retrying', attempts: 2 });
    s.close();
    const s2 = t.open(path);
    expect(s2.webhooks.list()).toEqual([w]);
    expect(s2.webhooks.listDeliveries()).toEqual([d]);
    s2.close();
  });
});
