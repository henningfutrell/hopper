// A test app for the webhook subscriptions and their signing secrets (issue #451): started on a fresh
// database with the subscriptions given, its console captured so a test can check no log line carries a
// secret, and the helpers that read the rows as stored, edit through the UI session, and wait for a delivery.
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from './app.ts';
import { ownerSchemaUrlFor } from './database.ts';
import { writeWebhooks, type WebhookEntry } from './files.ts';
import { startReceiver, type Receiver } from './receiver.ts';
import { waitFor } from './wait.ts';

export const KEY = randomBytes(32).toString('hex');
export const NEW_KEY = randomBytes(32).toString('hex');
export const ENTERED = 'entered-secret-0123456789abcdef0123456789';
export const REPLACED = 'replaced-secret-0123456789abcdef012345678';

/** Two subscriptions from before issue #451: each names the runtime variable its secret is in. */
export const TWO: WebhookEntry[] = [
  { name: 'grok-bot', url: 'http://127.0.0.1:4795/hook', events: ['question.escalated', 'job.finished'], secretEnv: 'WEBHOOK_SECRET_GROK', active: true },
  { name: 'other', url: 'http://127.0.0.1:4796/other', events: ['*'], secretEnv: 'WEBHOOK_SECRET_OTHER' },
];
export const RUNTIME = { HOPPER_MASTER_KEY: KEY, WEBHOOK_SECRET_GROK: 's-grok', WEBHOOK_SECRET_OTHER: 's-other' };
export const BEFORE = TWO.map(({ name, url, events, active }) => ({ name, url, events, active: active ?? true }));

export const signatureOf = (secret: string, got: { headers: Record<string, unknown>; body: string }) =>
  `sha256=${createHmac('sha256', secret).update(`${String(got.headers['x-hopper-timestamp'])}.${got.body}`).digest('hex')}`;
export const subOf = (body: Record<string, unknown>, name: string) => (body.subscriptions as { name: string }[]).find((s) => s.name === name) as Record<string, unknown>;

/** Every row of the store's subscriptions, as stored. */
export const storedRows = (a: TestApp): Record<string, unknown>[] => {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try {
    return db.all('SELECT * FROM webhooks ORDER BY seq');
  } finally {
    db.close();
  }
};
export const rowOf = (a: TestApp, name: string) => storedRows(a).find((r) => r.name === name)!;
/** The subscriptions as the store holds them, without ids and timestamps. */
export const stored = (a: TestApp) => a.user().store.webhooks.list().map(({ name, url, events, active }) => ({ name, url, events, active }));
export const list = async (a: TestApp) => (await a.api('GET', '/api/webhooks')).body;
export const edit = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, any>>('/ui/api/webhooks', body, { token }); // eslint-disable-line @typescript-eslint/no-explicit-any

/** One job finished: the next `job.finished` delivery, as the receiver got it. */
export async function nextDelivery(a: TestApp, rx: Receiver): Promise<{ headers: Record<string, unknown>; body: string }> {
  const before = rx.received.length;
  const job = await a.pull({ op: 'echo' });
  await a.waitForStatus(job.id, 'finished');
  return waitFor(() => rx.received[before]);
}

/** The app of one test, stopped after it; its receivers closed; the console captured. */
export function useWebhookApp() {
  let t: TestApp | undefined;
  let cleanup: (() => void) | undefined;
  const receivers: Receiver[] = [];
  let logged: string[] = [];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
  });

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    for (const r of receivers.splice(0)) await r.close();
    cleanup?.();
    vi.restoreAllMocks();
  });

  return {
    /** `webhooks` are the subscriptions in the database at start; `secrets` is the runtime's environment. */
    async start(webhooks: WebhookEntry[] = [], secrets: Record<string, string> = { ...RUNTIME }): Promise<{ a: TestApp; token: string }> {
      const db = tempDbPath();
      cleanup = db.cleanup;
      writeWebhooks(db.dbPath, webhooks);
      t = await startTestApp({ dbPath: db.dbPath, secrets });
      return { a: t, token: await t.login() };
    },
    /** The same database, the daemon started again with `secrets`. */
    async restart(a: TestApp, secrets: Record<string, string | undefined>): Promise<{ a: TestApp; token: string }> {
      const dbPath = a.dbPath;
      await a.stop();
      t = await startTestApp({ dbPath, secrets });
      return { a: t, token: await t.login() };
    },
    async receiver(status = 200): Promise<Receiver> {
      const r = await startReceiver(status);
      receivers.push(r);
      return r;
    },
    /** Nothing the hopper answered, logged or appended to the event log carries `secret`. */
    async nowhere(a: TestApp, secret: string): Promise<void> {
      expect(JSON.stringify(await list(a))).not.toContain(secret);
      expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(secret);
      expect(JSON.stringify(a.user().store.webhooks.list())).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret);
    },
  };
}
