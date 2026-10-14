// The Webhooks view's model (issue #18): the events picker, the last delivery a subscription card
// shows, and what it says about the signing secret (issue #451). Pure; tested from
// test/ui/webhooks.test.ts.
import { EVENT_TYPES } from './event-types.ts';
import type { WebhookDelivery, WebhookView } from './wire.ts';

/** What a subscription may name: "*" (every event) or event types. */
export const EVENT_CHOICES: readonly string[] = ['*', ...EVENT_TYPES];

/** Toggle one choice. "*" stands alone: choosing it drops the rest, choosing a type drops it. */
export function toggleEvent(events: readonly string[], choice: string): string[] {
  if (events.includes(choice)) return events.filter((e) => e !== choice);
  if (choice === '*') return ['*'];
  const next = new Set([...events.filter((e) => e !== '*'), choice]);
  return EVENT_CHOICES.filter((c) => next.has(c));
}

/** The subscription's most recently updated delivery, if any. */
export function lastDelivery(deliveries: readonly WebhookDelivery[], subscriptionId: string): WebhookDelivery | undefined {
  let last: WebhookDelivery | undefined;
  for (const d of deliveries) if (d.subscriptionId === subscriptionId && (!last || d.updatedAt > last.updatedAt)) last = d;
  return last;
}

/**
 * A subscription's signing secret as its card shows it (issue #451): stored in the hopper (and when it
 * changed), read from the runtime variable a subscription from before names, or none; with why it cannot
 * sign, if so. Never the secret: the hopper answers none.
 */
export type SecretState =
  | { kind: 'stored'; changedAt: string; problem?: string }
  | { kind: 'runtime'; variable: string; problem?: string }
  | { kind: 'none'; problem?: string };

export function secretOf(sub: WebhookView): SecretState {
  const problem = sub.secretProblem !== undefined ? { problem: sub.secretProblem } : {};
  if (sub.secretChangedAt !== undefined) return { kind: 'stored', changedAt: sub.secretChangedAt, ...problem };
  if (sub.secretEnv !== undefined) return { kind: 'runtime', variable: sub.secretEnv, ...problem };
  return { kind: 'none', ...problem };
}
