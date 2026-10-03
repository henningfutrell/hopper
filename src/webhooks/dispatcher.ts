import type { Clock, Store, WebhookDispatcher } from '../domain/ports.ts';
import type { DomainEvent, WebhookDelivery, WebhookSubscription } from '../domain/types.ts';
import { sign } from './signer.ts';

export interface WebhookDispatcherOptions {
  store: Store;
  clock: Clock;
  baseMs: number;
  timeoutMs?: number;
  maxAttempts?: number;
  sweepMs?: number;
}

const MAX_BACKOFF_MS = 300_000;
const IN_FLIGHT_GRACE_MS = 1000;

export function createWebhookDispatcher(o: WebhookDispatcherOptions): WebhookDispatcher {
  const { store, clock, baseMs } = o;
  const timeoutMs = o.timeoutMs ?? 5000;
  const maxAttempts = o.maxAttempts ?? 6;
  const sweepMs = o.sweepMs ?? 500;
  const listeners = new Set<(d: WebhookDelivery) => void>();
  const inFlight = new Map<string, Promise<void>>();
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const after = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();

  function update(id: string, patch: Partial<WebhookDelivery>): WebhookDelivery {
    const d = store.webhooks.updateDelivery(id, patch);
    for (const l of [...listeners]) l(d);
    return d;
  }

  function matches(sub: WebhookSubscription, event: DomainEvent): boolean {
    return sub.active && (sub.events.includes('*') || sub.events.includes(event.type));
  }

  function enqueue(event: DomainEvent): void {
    for (const sub of store.webhooks.list()) {
      if (!matches(sub, event)) continue;
      const d = store.webhooks.createDelivery(sub.id, event);
      for (const l of [...listeners]) l(d);
    }
    // Listeners must not re-enter synchronously (ports.ts): defer the sweep.
    setImmediate(sweep);
  }

  async function post(d: WebhookDelivery, sub: WebhookSubscription, event: DomainEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    let statusCode: number | undefined;
    let error: string | undefined;
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-jobhopper-event': event.type,
          'x-jobhopper-delivery': d.id,
          'x-jobhopper-timestamp': timestamp,
          'x-jobhopper-signature': sign(sub.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      statusCode = res.status;
      await res.body?.cancel();
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = d.attempts + 1;
    if (error === undefined) {
      update(d.id, { status: 'delivered', attempts, lastStatusCode: statusCode, lastError: undefined, nextAttemptAt: undefined });
    } else if (attempts >= maxAttempts) {
      update(d.id, { status: 'failed', attempts, lastStatusCode: statusCode, lastError: error, nextAttemptAt: undefined });
    } else {
      const backoff = Math.min(baseMs * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      update(d.id, { status: 'retrying', attempts, lastStatusCode: statusCode, lastError: error, nextAttemptAt: after(backoff) });
    }
  }

  async function attempt(d: WebhookDelivery): Promise<void> {
    const sub = store.webhooks.get(d.subscriptionId);
    if (!sub) return; // deleted: the store already failed its deliveries
    if (!sub.active) {
      update(d.id, { status: 'failed', lastError: 'subscription inactive', nextAttemptAt: undefined });
      return;
    }
    const event = store.events.since(d.eventSeq - 1, 1)[0];
    if (!event || event.seq !== d.eventSeq) {
      update(d.id, { status: 'failed', lastError: 'event not found', nextAttemptAt: undefined });
      return;
    }
    update(d.id, { nextAttemptAt: after(timeoutMs + IN_FLIGHT_GRACE_MS) });
    await post(d, sub, event);
  }

  function sweep(): void {
    if (!running) return;
    for (const d of store.webhooks.dueDeliveries(clock.now())) {
      if (inFlight.has(d.id)) continue;
      const p = attempt(d)
        .catch((e) => console.error('webhook delivery error', d.id, e))
        .finally(() => inFlight.delete(d.id));
      inFlight.set(d.id, p);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = store.events.subscribe(enqueue);
      timer = setInterval(sweep, sweepMs);
      timer.unref();
      sweep();
    },
    async stop() {
      running = false;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.all(inFlight.values());
    },
    onDeliveryUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
