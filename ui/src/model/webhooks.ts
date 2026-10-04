// The Webhooks view's model (issue #18): the events picker, the variable a new subscription's secret
// is in (issue #56), and the last delivery a subscription card shows. Pure; tested from
// test/ui/webhooks.test.ts.
import { EVENT_TYPES } from './event-types.ts';
import type { WebhookDelivery } from './wire.ts';

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

/** The WEBHOOK_SECRET_* variable suggested for a new subscription named `name`: the only kind a UI session may name. */
export function secretEnvFor(name: string): string {
  return `WEBHOOK_SECRET_${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
