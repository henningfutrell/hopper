import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookDispatcher, verify } from '../../src/webhooks/index.ts';
import type { WebhookDelivery } from '../../src/domain/types.ts';
import { createFakeStore, type FakeStore } from './fakeStore.ts';
import { startReceiver, type Receiver, type Responder } from './receiver.ts';

const clock = { now: () => new Date() };
const ok: Responder = (_n, res) => { res.statusCode = 200; res.end('ok'); };

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let receiver: Receiver | undefined;
let fake: FakeStore;
let stopFn: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopFn?.();
  stopFn = undefined;
  await receiver?.close();
  receiver = undefined;
});

/** The runtime's secrets (issue #56): what the dispatcher reads a subscription's secret from, at each delivery. */
let secrets: Record<string, string>;

function setup(responder: Responder, o: { timeoutMs?: number; maxAttempts?: number } = {}) {
  fake = createFakeStore();
  secrets = { HOOK_SECRET: 'shh' };
  const dispatcher = createWebhookDispatcher({ store: fake.store, clock, secret: (name) => secrets[name], baseMs: 20, sweepMs: 10, ...o });
  const updates: WebhookDelivery[] = [];
  dispatcher.onDeliveryUpdated((d) => updates.push(d));
  stopFn = () => dispatcher.stop();
  return { dispatcher, updates, receiverP: startReceiver(responder) };
}

describe('webhook dispatcher', () => {
  it('POSTs a signed event with the contract headers', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    secrets.TOP = 'topsecret';
    fake.subscribe({ url: receiver.url, events: ['*'], secretEnv: 'TOP' });
    s.dispatcher.start();
    const ev = fake.append('job.queued', { x: 1 });
    await until(() => fake.deliveries()[0]?.status === 'delivered');

    const r = receiver.received[0]!;
    expect(r.body).toBe(JSON.stringify(ev));
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['x-hopper-event']).toBe('job.queued');
    expect(r.headers['x-hopper-delivery']).toBe(fake.deliveries()[0]!.id);
    const ts = r.headers['x-hopper-timestamp'] as string;
    expect(ts).toMatch(/^\d+$/);
    expect(verify('topsecret', ts, r.body, r.headers['x-hopper-signature'] as string)).toBe(true);
    expect(fake.deliveries()[0]!.attempts).toBe(1);
    expect(s.updates.at(-1)!.status).toBe('delivered');
  });

  it('respects the event filter: explicit types and "*"; skips inactive subscriptions', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    const only = fake.subscribe({ url: receiver.url, events: ['job.finished'] });
    const all = fake.subscribe({ url: receiver.url, events: ['*'] });
    fake.subscribe({ url: receiver.url, events: ['*'], active: false });
    s.dispatcher.start();
    fake.append('job.queued');
    fake.append('job.finished');
    await until(() => fake.deliveries().length === 3 && fake.deliveries().every((d) => d.status === 'delivered'));

    const bySub = (id: string) => fake.deliveries().filter((d) => d.subscriptionId === id).map((d) => d.eventType);
    expect(bySub(only.id)).toEqual(['job.finished']);
    expect(bySub(all.id)).toEqual(['job.queued', 'job.finished']);
  });

  it('retries a 500 with growing backoff, then delivers (attempts 2)', async () => {
    const s = setup((n, res) => { res.statusCode = n === 1 ? 500 : 200; res.end(); });
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'delivered');

    expect(fake.deliveries()[0]!.attempts).toBe(2);
    const retry = s.updates.find((u) => u.status === 'retrying')!;
    expect(retry.lastStatusCode).toBe(500);
    expect(retry.attempts).toBe(1);
    expect(receiver.received).toHaveLength(2);
  });

  it('backs off exponentially and fails after maxAttempts', async () => {
    const stamps: number[] = [];
    const s = setup((_n, res) => { stamps.push(Date.now()); res.statusCode = 500; res.end(); }, { maxAttempts: 4 });
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'failed');
    await new Promise((r) => setTimeout(r, 150));

    const d = fake.deliveries()[0]!;
    expect(d.attempts).toBe(4);
    expect(d.lastStatusCode).toBe(500);
    expect(receiver.received).toHaveLength(4);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(18);
    expect(gaps[2]!).toBeGreaterThanOrEqual(78);
  });

  it('times out a slow receiver, retries, and never sends concurrently', async () => {
    const s = setup((n, res) => {
      if (n === 1) { setTimeout(() => { if (!res.destroyed) res.end(); }, 600); return; }
      res.statusCode = 200; res.end();
    }, { timeoutMs: 100 });
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'delivered');

    expect(fake.deliveries()[0]!.attempts).toBe(2);
    expect(receiver.maxActive()).toBe(1);
    expect(s.updates.find((u) => u.status === 'retrying')!.lastError).toBeTruthy();
  });

  it('reads the secret at each delivery: a secret the runtime rotates signs the next delivery', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'delivered');
    secrets.HOOK_SECRET = 'rotated';
    fake.append('job.finished');
    await until(() => fake.deliveries()[1]?.status === 'delivered');
    const [a, b] = receiver.received;
    expect(verify('shh', a!.headers['x-hopper-timestamp'] as string, a!.body, a!.headers['x-hopper-signature'] as string)).toBe(true);
    expect(verify('rotated', b!.headers['x-hopper-timestamp'] as string, b!.body, b!.headers['x-hopper-signature'] as string)).toBe(true);
  });

  it('a secret the runtime does not provide: nothing is sent; the delivery retries, naming the variable', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'], secretEnv: 'UNSET_SECRET' });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'retrying');
    expect(fake.deliveries()[0]!.lastError).toContain('UNSET_SECRET is not set');
    expect(receiver.received).toHaveLength(0);
  });

  it('stop() unsubscribes and halts sending', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    expect(fake.listenerCount()).toBe(1);
    await s.dispatcher.stop();
    expect(fake.listenerCount()).toBe(0);
    fake.append('job.queued');
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(0);
    expect(fake.deliveries()).toHaveLength(0);
  });

  it('onDeliveryUpdated unsubscribe stops notifications', async () => {
    const s = setup(ok);
    receiver = await s.receiverP;
    const seen: WebhookDelivery[] = [];
    const off = s.dispatcher.onDeliveryUpdated((d) => seen.push(d));
    off();
    fake.subscribe({ url: receiver.url, events: ['*'] });
    s.dispatcher.start();
    fake.append('job.queued');
    await until(() => fake.deliveries()[0]?.status === 'delivered');
    expect(seen).toHaveLength(0);
    expect(s.updates.length).toBeGreaterThan(0);
  });
});
