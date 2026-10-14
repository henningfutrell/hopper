// The Webhooks view's model (issue #18): the events picker ("*" or event types, never both) and
// the last delivery a subscription card shows.
import { describe, expect, it } from 'vitest';
import type { WebhookDelivery } from '../../src/domain/types.ts';
import { EVENT_CHOICES, lastDelivery, secretOf, toggleEvent } from '../../ui/src/model/webhooks.ts';

describe('toggleEvent', () => {
  it('adds and removes an event type, keeping the choices order', () => {
    expect(toggleEvent(['job.failed'], 'job.queued')).toEqual(['job.queued', 'job.failed']);
    expect(toggleEvent(['job.queued', 'job.failed'], 'job.queued')).toEqual(['job.failed']);
  });

  it('"*" stands alone: choosing it drops the rest, choosing a type drops it', () => {
    expect(toggleEvent(['job.failed', 'job.finished'], '*')).toEqual(['*']);
    expect(toggleEvent(['*'], 'job.failed')).toEqual(['job.failed']);
    expect(toggleEvent(['*'], '*')).toEqual([]);
  });

  it('offers "*" first, then every event type', () => {
    expect(EVENT_CHOICES[0]).toBe('*');
    expect(EVENT_CHOICES).toContain('question.escalated');
    expect(EVENT_CHOICES).toContain('question.escalated_to_human');
  });
});

const delivery = (id: string, subscriptionId: string, updatedAt: string): WebhookDelivery => ({
  id, subscriptionId, eventSeq: 1, eventType: 'job.finished', status: 'delivered', attempts: 1, createdAt: updatedAt, updatedAt,
});

describe('lastDelivery', () => {
  it('is the subscription\'s most recently updated delivery', () => {
    const ds = [delivery('a', 's1', '2026-10-03T10:00:00Z'), delivery('b', 's1', '2026-10-03T11:00:00Z'), delivery('c', 's2', '2026-10-03T12:00:00Z')];
    expect(lastDelivery(ds, 's1')?.id).toBe('b');
    expect(lastDelivery(ds, 's3')).toBeUndefined();
  });
});

// Issue #451: the card says whether a secret is stored (and when it changed), or that one from before
// still reads a runtime variable, and why there is none to sign with — never the secret.
describe('secretOf', () => {
  const sub = { id: 's', name: 'hook', url: 'http://127.0.0.1:1/', events: ['*'], active: true, createdAt: '2026-10-01T00:00:00.000Z' };

  it('stored: set, with when it changed', () => {
    expect(secretOf({ ...sub, secretChangedAt: '2026-10-08T10:00:00.000Z' })).toEqual({ kind: 'stored', changedAt: '2026-10-08T10:00:00.000Z' });
  });

  it('from before: the runtime variable, to replace', () => {
    expect(secretOf({ ...sub, secretEnv: 'WEBHOOK_SECRET_HOOK' })).toEqual({ kind: 'runtime', variable: 'WEBHOOK_SECRET_HOOK' });
  });

  it('neither: none', () => {
    expect(secretOf(sub)).toEqual({ kind: 'none' });
  });

  it('a problem goes with each', () => {
    expect(secretOf({ ...sub, secretChangedAt: '2026-10-08T10:00:00.000Z', secretProblem: 'the stored secret cannot be opened' }))
      .toEqual({ kind: 'stored', changedAt: '2026-10-08T10:00:00.000Z', problem: 'the stored secret cannot be opened' });
  });
});
