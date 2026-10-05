// The event log over HTTP and SSE, and webhook subscriptions, rows in the database (issue #78):
// signed deliveries carrying schemaVersion.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSIONS, type DomainEvent, type WebhookDelivery } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeWebhooks } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { openSse, type SseClient } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let sse: SseClient | undefined;
const receivers: Receiver[] = [];

/** The runtime's secrets every subscription here names (issue #56). */
const SECRETS = { WH_ONE: 'abc', WH_R: 'k3y', WH_R1: 's1', WH_R2: 's2' };

async function start(before?: (dbPath: string) => void): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { ...SECRETS } });
  return t;
}
async function receiver(): Promise<Receiver> {
  const r = await startReceiver();
  receivers.push(r);
  return r;
}

afterEach(async () => {
  sse?.close();
  sse = undefined;
  await t?.stop();
  t = undefined;
  for (const r of receivers.splice(0)) await r.close();
  cleanup?.();
});

describe('events', () => {
  it('lists events after a seq, filtered by type', async () => {
    const a = await start();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const all = await a.events('after=0&limit=1000');
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((x, y) => x - y));
    expect(all.every((e) => e.schemaVersion === EVENT_SCHEMA_VERSIONS[e.type])).toBe(true);
    const after = await a.events(`after=${all[1]!.seq}&limit=1`);
    expect(after.map((e) => e.seq)).toEqual([all[2]!.seq]);
    const some = await a.events('types=job.finished,job.queued');
    expect(new Set(some.map((e) => e.type))).toEqual(new Set(['job.finished', 'job.queued']));
    expect((await a.api('GET', '/api/events?types=job.nope')).status).toBe(400);
  });

  it('the SSE stream replays after a seq, then delivers live events with id/event/data framing', async () => {
    const a = await start();
    const first = await a.pull({ op: 'echo' });
    await a.waitForStatus(first.id, 'finished');
    const past = await a.events();
    const pivot = past[2]!.seq;
    sse = await openSse(`${a.url}/api/events/stream?after=${pivot}`);
    await waitFor(() => sse!.messages.filter((m) => m.id !== undefined).length >= past.length - 3, { what: 'replay' });
    const replayed = sse.messages.filter((m) => m.id !== undefined).map((m) => Number(m.id));
    expect(replayed[0]).toBe(past[3]!.seq);
    const live = await a.pull({ op: 'echo' });
    const fin = await waitFor(() => sse!.messages.find((m) => m.event === 'job.finished' && (JSON.parse(m.data) as DomainEvent).jobId === live.id));
    expect(fin.id).toBe(String((JSON.parse(fin.data) as DomainEvent).seq));
    const ids = sse.messages.filter((m) => m.id !== undefined).map((m) => Number(m.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the SSE stream honours Last-Event-ID', async () => {
    const a = await start();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const past = await a.events();
    const lastSeq = past[past.length - 1]!.seq;
    sse = await openSse(`${a.url}/api/events/stream`, { 'last-event-id': String(lastSeq - 1) });
    const m = await waitFor(() => sse!.messages.find((x) => x.id !== undefined));
    expect(Number(m.id)).toBe(lastSeq);
  });

  it('a reconnect resumes at Last-Event-ID, not at the stale after= of the URL it reuses', async () => {
    const a = await start();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const past = await a.events();
    const lastSeq = past[past.length - 1]!.seq;
    sse = await openSse(`${a.url}/api/events/stream?after=0`, { 'last-event-id': String(lastSeq - 1) });
    const m = await waitFor(() => sse!.messages.find((x) => x.id !== undefined));
    expect(Number(m.id)).toBe(lastSeq);
  });

  it('the SSE stream emits source.updated (no id) after a sync', async () => {
    const a = await start();
    sse = await openSse(`${a.url}/api/events/stream`);
    await a.sync();
    const m = await waitFor(() => sse!.messages.find((x) => x.event === 'source.updated' && JSON.parse(x.data).name === 'manual'));
    expect(m.id).toBeUndefined();
    expect(JSON.parse(m.data)).toMatchObject({ name: 'manual', kind: 'manual', state: 'ok' });
  });
});

describe('webhook subscriptions', () => {
  it('lists the subscriptions by name without secrets, and nothing else', async () => {
    const a = await start((db) => writeWebhooks(db, [{ name: 'one', url: 'http://127.0.0.1:9/x', events: ['job.finished'], secretEnv: 'WH_ONE' }]));
    const body = (await a.api('GET', '/api/webhooks')).body;
    expect(body.subscriptions).toEqual([expect.objectContaining({ name: 'one', url: 'http://127.0.0.1:9/x', events: ['job.finished'], active: true })]);
    for (const s of body.subscriptions) expect(s).not.toHaveProperty('secret');
    expect(JSON.stringify(body)).not.toContain('abc');
    expect(Object.keys(body)).toEqual(['subscriptions']);
  });

  it('a real receiver gets signed deliveries with schemaVersion; deliveries are listed and streamed', async () => {
    const r = await receiver();
    const a = await start((db) => writeWebhooks(db, [{ name: 'r', url: r.url, events: ['job.finished'], secretEnv: 'WH_R' }]));
    const sub = (await a.api('GET', '/api/webhooks')).body.subscriptions[0];
    sse = await openSse(`${a.url}/api/events/stream`);
    const job = await a.pull({ op: 'echo', message: 'ping' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => r.received[0], { what: 'delivery' });
    const ts = got.headers['x-hopper-timestamp'] as string;
    expect(got.headers['x-hopper-signature']).toBe('sha256=' + createHmac('sha256', 'k3y').update(`${ts}.${got.body}`).digest('hex'));
    expect(got.headers['x-hopper-event']).toBe('job.finished');
    expect(JSON.parse(got.body)).toMatchObject({ type: 'job.finished', jobId: job.id, schemaVersion: 1 });
    const deliveries = await waitFor(async () => {
      const ds = (await a.api<{ deliveries: WebhookDelivery[] }>('GET', `/api/webhooks/deliveries?subscriptionId=${sub.id}&limit=10`)).body.deliveries;
      return ds[0]?.status === 'delivered' ? ds : undefined;
    });
    expect(got.headers['x-hopper-delivery']).toBe(deliveries[0]!.id);
    const update = await waitFor(() => sse!.messages.find((m) => m.event === 'delivery.updated' && (JSON.parse(m.data) as WebhookDelivery).status === 'delivered'));
    expect(update.id).toBeUndefined();
  });
});
