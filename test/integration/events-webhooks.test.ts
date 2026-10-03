import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, WebhookDelivery } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { openSse, type SseClient } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp;
let cleanup: () => void;
let sse: SseClient | undefined;
let receiver: Receiver | undefined;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
});
afterEach(async () => {
  sse?.close();
  sse = undefined;
  await receiver?.close();
  receiver = undefined;
  await t.stop();
  cleanup();
});

describe('events', () => {
  it('lists events after a seq, filtered by type', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(job.id, 'finished');
    const all = await t.events('after=0&limit=1000');
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));
    const after = await t.events(`after=${all[1]!.seq}&limit=1`);
    expect(after.map((e) => e.seq)).toEqual([all[2]!.seq]);
    const finished = await t.events('types=job.finished,job.queued');
    expect(new Set(finished.map((e) => e.type))).toEqual(new Set(['job.finished', 'job.queued']));
    expect((await t.api('GET', '/api/events?types=job.nope')).status).toBe(400);
  });

  it('the SSE stream replays after a seq, then delivers live events with id/event/data framing', async () => {
    const first = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(first.id, 'finished');
    const past = await t.events();
    const pivot = past[2]!.seq;
    sse = await openSse(`${t.url}/api/events/stream?after=${pivot}`);
    await waitFor(() => sse!.messages.length >= past.length - 3, { what: 'replay' });
    const replayed = sse.messages.map((m) => Number(m.id));
    expect(replayed[0]).toBe(past[3]!.seq);
    expect(new Set(replayed).size).toBe(replayed.length);

    const live = await t.push({ executor: 'test', payload: { op: 'echo' } });
    const fin = await waitFor(() => sse!.messages.find((m) => m.event === 'job.finished'
      && (JSON.parse(m.data) as DomainEvent).jobId === live.id));
    const event = JSON.parse(fin.data) as DomainEvent;
    expect(fin.id).toBe(String(event.seq));
    expect(event.type).toBe('job.finished');
    const ids = sse.messages.filter((m) => m.id !== undefined).map((m) => Number(m.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the SSE stream honours Last-Event-ID', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'echo' } });
    await t.waitForStatus(job.id, 'finished');
    const past = await t.events();
    const lastSeq = past[past.length - 1]!.seq;
    sse = await openSse(`${t.url}/api/events/stream`, { 'last-event-id': String(lastSeq - 1) });
    const m = await waitFor(() => sse!.messages[0]);
    expect(Number(m.id)).toBe(lastSeq);
  });
});

describe('webhooks', () => {
  it('creates, lists without the secret, deletes, and validates subscriptions', async () => {
    const created = await t.api('POST', '/api/webhooks', { url: 'http://127.0.0.1:9/x', events: ['job.finished'] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body).toMatchObject({ url: 'http://127.0.0.1:9/x', events: ['job.finished'], active: true });
    const given = await t.api('POST', '/api/webhooks', { url: 'https://example.invalid/h', secret: 's3cret' });
    expect(given.body).toMatchObject({ secret: 's3cret', events: ['*'] });
    const { subscriptions } = (await t.api('GET', '/api/webhooks')).body;
    expect(subscriptions).toHaveLength(2);
    for (const s of subscriptions) expect(s).not.toHaveProperty('secret');
    expect((await t.api('POST', '/api/webhooks', { url: 'ftp://x/y' })).status).toBe(400);
    expect((await t.api('POST', '/api/webhooks', { url: 'not a url' })).status).toBe(400);
    expect((await t.api('POST', '/api/webhooks', { url: 'http://a/b', events: ['job.nope'] })).status).toBe(400);
    expect((await t.api('DELETE', `/api/webhooks/${created.body.id}`)).status).toBe(204);
    expect((await t.api('DELETE', `/api/webhooks/${created.body.id}`)).status).toBe(404);
  });

  it('a real receiver gets signed deliveries; deliveries are listed and streamed', async () => {
    receiver = await startReceiver();
    const sub = (await t.api('POST', '/api/webhooks', { url: receiver.url, events: ['job.finished'] })).body;
    sse = await openSse(`${t.url}/api/events/stream`);
    const job = await t.push({ executor: 'test', payload: { op: 'echo', message: 'ping' } });
    await t.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => receiver!.received[0], { what: 'delivery' });
    const ts = got.headers['x-jobhopper-timestamp'] as string;
    const expected = 'sha256=' + createHmac('sha256', sub.secret).update(`${ts}.${got.body}`).digest('hex');
    expect(got.headers['x-jobhopper-signature']).toBe(expected);
    expect(got.headers['x-jobhopper-event']).toBe('job.finished');
    expect(JSON.parse(got.body)).toMatchObject({ type: 'job.finished', jobId: job.id });

    const deliveries = await waitFor(async () => {
      const ds = (await t.api<{ deliveries: WebhookDelivery[] }>('GET', `/api/webhooks/deliveries?subscriptionId=${sub.id}&limit=10`)).body.deliveries;
      return ds[0]?.status === 'delivered' ? ds : undefined;
    });
    expect(deliveries[0]).toMatchObject({ subscriptionId: sub.id, eventType: 'job.finished', attempts: 1 });
    expect(got.headers['x-jobhopper-delivery']).toBe(deliveries[0]!.id);
    const update = await waitFor(() => sse!.messages.find((m) => m.event === 'delivery.updated'
      && (JSON.parse(m.data) as WebhookDelivery).status === 'delivered'));
    expect(update.id).toBeUndefined();
  });
});
