// The Webhooks view's model (issue #18): the events picker ("*" or event types, never both) and
// the last delivery a subscription card shows.
import { describe, expect, it } from 'vitest';
import type { WebhookDelivery } from '../../src/domain/types.ts';
import { EVENT_CHOICES, lastDelivery, secretEnvFor, toggleEvent } from '../../ui/src/model/webhooks.ts';

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

describe('secretEnvFor (issue #56)', () => {
  it('suggests the WEBHOOK_SECRET_* variable a new subscription names, from its name', () => {
    expect(secretEnvFor('grok-bot')).toBe('WEBHOOK_SECRET_GROK_BOT');
    expect(secretEnvFor(' my.phone 2 ')).toBe('WEBHOOK_SECRET_MY_PHONE_2');
    expect(secretEnvFor('')).toBe('WEBHOOK_SECRET_');
  });
});
