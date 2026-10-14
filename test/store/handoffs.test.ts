// The hand-offs (issue #516), in the database: an open hand-off is never dropped by age; a closed one is deleted
// once older than the retention. Tenant migration 23 adds the table only, so the build before still runs on it.
import { describe, expect, it } from 'vitest';
import type { Handoff } from '../../src/domain/types.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const input = (over: Partial<Handoff> = {}): Omit<Handoff, 'id'> => ({
  jobId: 'j1', status: 'open', reason: 'person', openedAt: '2026-01-01T00:00:00.000Z', summary: 'Needs a person.', reasons: ['no known cause matches'],
  error: 'HOPPER_FAILED tests fail', ...over,
});

describe('hand-offs in the database', () => {
  it('an open one survives any age; a closed one goes after the retention', () => {
    const store = t.open(t.url(), fixedClock('2026-10-08T00:00:00.000Z'));
    const open = store.handoffs.create(input());
    const oldClosed = store.handoffs.create(input({ jobId: 'j2', status: 'closed', end: 'cleared', closedAt: '2026-01-02T00:00:00.000Z' }));
    const newClosed = store.handoffs.create(input({ jobId: 'j3', status: 'closed', end: 'cleared', closedAt: '2026-10-07T00:00:00.000Z' }));
    expect(store.handoffs.prune('2026-10-01T00:00:00.000Z')).toBe(1);
    expect(store.handoffs.get(open.id)).toMatchObject({ status: 'open' });
    expect(store.handoffs.get(oldClosed.id)).toBeUndefined();
    expect(store.handoffs.get(newClosed.id)).toBeDefined();
    expect(store.handoffs.list({ status: 'open' }).map((h) => h.id)).toEqual([open.id]);
    expect(store.handoffs.forJob('j1')?.id).toBe(open.id);
    store.close();
  });

  it('a failure prune leaves an open hand-off alone', () => {
    const store = t.open(t.url(), fixedClock('2026-10-08T00:00:00.000Z'));
    const h = store.handoffs.create(input());
    store.failures.prune('2027-01-01T00:00:00.000Z');
    expect(store.handoffs.get(h.id)).toMatchObject({ status: 'open' });
    store.close();
  });
});
