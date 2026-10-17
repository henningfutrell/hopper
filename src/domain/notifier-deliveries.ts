// Notifier deliveries (issue #1587, design.md "Grok Bot routine webhook"): one row per notification a notifier sends about an
// event, kept in the user's store until it is delivered or fails for good, so a stop loses none and a start sends what is due.
import type { DomainEvent } from './types.ts';

export type NotifierDeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed';

export interface NotifierDeliveryInput {
  /** The notifier instance that sends it. */
  notifier: string;
  /** What the receiver dedupes by (sent as `x-hopper-delivery`): one row per key and notifier. */
  key: string;
  /** What the post is, for the outbound guard and the send log: the event type, or the name it is sent as. */
  kind: string;
  jobId?: string;
  /** The event it is about: the payload is made from it at each attempt. */
  event: DomainEvent;
}

export interface NotifierDelivery extends NotifierDeliveryInput {
  id: string;
  status: NotifierDeliveryStatus;
  attempts: number;
  lastStatusCode?: number;
  lastError?: string;
  /** When it is tried next; none once delivered or failed. */
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type NotifierDeliveryPatch = Partial<Pick<NotifierDelivery, 'status' | 'attempts' | 'lastStatusCode' | 'lastError' | 'nextAttemptAt'>>;

export interface NotifierDeliveryRepository {
  /** A new pending delivery, due now; undefined when the notifier has one of that key already. */
  add(input: NotifierDeliveryInput): NotifierDelivery | undefined;
  /** A field patched to undefined is removed. Undefined: no such row. */
  update(id: string, patch: NotifierDeliveryPatch): NotifierDelivery | undefined;
  /** The notifier's pending and retrying deliveries due at `now`, oldest first. */
  due(notifier: string, now: Date): NotifierDelivery[];
  /** Remove delivered and failed rows last changed before `before`; how many. */
  prune(before: string): number;
}

/** How long a delivered or failed row is kept. */
export const NOTIFIER_DELIVERY_KEEP_DAYS = 14;
