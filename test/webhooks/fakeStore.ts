// In-memory stand-in for the parts of UserStore the webhook dispatcher uses.
import type { UserStore } from '../../src/domain/ports.ts';
import { EVENT_SCHEMA_VERSIONS, type DomainEvent, type NewEvent, type WebhookDelivery, type WebhookSubscription } from '../../src/domain/types.ts';

export interface FakeStore {
  store: UserStore;
  /** `secretEnv` defaults to HOOK_SECRET. */
  subscribe(input: { name?: string; url: string; events: string[]; secretEnv?: string; active?: boolean }): WebhookSubscription;
  deliveries(): WebhookDelivery[];
  append(type: DomainEvent['type'], data?: Record<string, unknown>): DomainEvent;
  listenerCount(): number;
}

export function createFakeStore(): FakeStore {
  const events: DomainEvent[] = [];
  const subs = new Map<string, WebhookSubscription>();
  const deliveries = new Map<string, WebhookDelivery>();
  const listeners = new Set<(e: DomainEvent) => void>();
  let n = 0;
  const iso = () => new Date().toISOString();

  const store = {
    events: {
      append(e: NewEvent): DomainEvent {
        const ev: DomainEvent = { ...e, schemaVersion: EVENT_SCHEMA_VERSIONS[e.type], seq: events.length + 1, id: `ev-${events.length + 1}`, at: e.at ?? iso() };
        events.push(ev);
        for (const l of [...listeners]) l(ev);
        return ev;
      },
      since: (after: number, limit = 100) => events.filter((e) => e.seq > after).slice(0, limit),
      recent: () => [...events].reverse(),
      subscribe(l: (e: DomainEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    webhooks: {
      add: (i: { name: string; url: string; events: string[]; active: boolean }) => fakeStore.subscribe(i),
      update: (id: string, patch: Partial<WebhookSubscription>) => { const s = subs.get(id); if (s) Object.assign(s, patch); return s; },
      get: (id: string) => subs.get(id),
      list: () => [...subs.values()],
      delete: (id: string) => subs.delete(id),
      createDelivery(subscriptionId: string, event: DomainEvent): WebhookDelivery {
        const d: WebhookDelivery = {
          id: `d-${++n}`, subscriptionId, eventSeq: event.seq, eventType: event.type,
          status: 'pending', attempts: 0, nextAttemptAt: iso(), createdAt: iso(), updatedAt: iso(),
        };
        deliveries.set(d.id, d);
        return { ...d };
      },
      updateDelivery(id: string, patch: Partial<WebhookDelivery>): WebhookDelivery {
        const d = { ...deliveries.get(id)!, ...patch, updatedAt: iso() };
        deliveries.set(id, d);
        return { ...d };
      },
      dueDeliveries: (now: Date) =>
        [...deliveries.values()].filter(
          (d) => (d.status === 'pending' || d.status === 'retrying') && new Date(d.nextAttemptAt!) <= now,
        ).map((d) => ({ ...d })),
      listDeliveries: () => [...deliveries.values()],
    },
  } as unknown as UserStore;

  const fakeStore: FakeStore = {
    store,
    subscribe(i) {
      const s: WebhookSubscription = {
        id: `s-${subs.size + 1}`, name: i.name ?? `hook-${subs.size + 1}`, url: i.url, events: i.events, secretEnv: i.secretEnv ?? 'HOOK_SECRET',
        active: i.active ?? true, createdAt: iso(),
      };
      subs.set(s.id, s);
      return s;
    },
    deliveries: () => [...deliveries.values()],
    append: (type, data = {}) => store.events.append({ type, data }),
    listenerCount: () => listeners.size,
  };
  return fakeStore;
}
