// Issue #18: webhook subscriptions are edited from the UI. Issue #78: the subscriptions are rows in the
// database and nothing else — POST /ui/api/webhooks adds, changes or removes one row, and the answer
// shows it. No config record holds them.
// Issue #56: every secret comes from the runtime. A subscription names the variable its secret is in
// (`secretEnv`); the hopper makes, stores and hands out no secret — not in the store, not in an
// answer. A UI session may name only a `WEBHOOK_SECRET_*` variable, so it can never point a
// subscription at another credential the runtime holds.
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_NAMES } from '../../src/domain/ports.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { ownerSchemaUrlFor } from '../support/database.ts';
import { writeWebhooks, type WebhookEntry } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const receivers: Receiver[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const r of receivers.splice(0)) await r.close();
  cleanup?.();
});

const TWO: WebhookEntry[] = [
  { name: 'grok-bot', url: 'http://127.0.0.1:4795/hook', events: ['question.escalated', 'job.finished'], secretEnv: 'WEBHOOK_SECRET_GROK', active: true },
  { name: 'other', url: 'http://127.0.0.1:4796/other', events: ['*'], secretEnv: 'WEBHOOK_SECRET_OTHER' },
];
const RUNTIME = { WEBHOOK_SECRET_GROK: 's-grok', WEBHOOK_SECRET_OTHER: 's-other' };

/** `webhooks` are the subscriptions in the database at start; `secrets` is the runtime's environment. */
async function start(webhooks: WebhookEntry[] = [], secrets: Record<string, string> = { ...RUNTIME }): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writeWebhooks(db.dbPath, webhooks);
  t = await startTestApp({ dbPath: db.dbPath, secrets });
  return { a: t, token: await t.login() };
}

/** Every row of the store's subscriptions, as stored. */
const storedRows = (a: TestApp): Record<string, unknown>[] => {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try {
    return db.all('SELECT * FROM webhooks ORDER BY seq');
  } finally {
    db.close();
  }
};
/** The subscriptions as the store holds them, without ids and timestamps. */
const stored = (a: TestApp) => a.user().store.webhooks.list().map(({ name, url, events, secretEnv, active }) => ({ name, url, events, secretEnv, active }));
const list = async (a: TestApp) => (await a.api('GET', '/api/webhooks')).body;
const edit = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, any>>('/ui/api/webhooks', body, { token }); // eslint-disable-line @typescript-eslint/no-explicit-any
const signatureOf = (secret: string, got: { headers: Record<string, unknown>; body: string }) =>
  `sha256=${createHmac('sha256', secret).update(`${String(got.headers['x-hopper-timestamp'])}.${got.body}`).digest('hex')}`;
const BEFORE = TWO.map((w) => ({ ...w, active: w.active ?? true }));

describe('GET /api/webhooks: what the UI edits', () => {
  it('carries each subscription\'s variable and whether the runtime provides it; never a secret, no config record', async () => {
    const { a } = await start(TWO, { WEBHOOK_SECRET_GROK: 's-grok' });
    const body = await list(a);
    expect(JSON.stringify(body)).not.toContain('s-grok');
    expect(body.subscriptions.map((s: Record<string, unknown>) => [s.name, s.secretEnv, s.secretProblem])).toEqual([
      ['grok-bot', 'WEBHOOK_SECRET_GROK', undefined],
      ['other', 'WEBHOOK_SECRET_OTHER', 'WEBHOOK_SECRET_OTHER is not set'],
    ]);
    expect(body.subscriptions.every((s: object) => !('secret' in s))).toBe(true);
    expect(body).not.toHaveProperty('config');
  });

  it('no config record holds them', () => {
    expect(CONFIG_NAMES).not.toContain('webhooks');
  });
});

describe('secrets come from the runtime (issue #56)', () => {
  it('the store keeps no secret: each subscription row holds the variable name only', async () => {
    const { a } = await start(TWO);
    const rows = storedRows(a);
    expect(rows.map((r) => [r.name, r.secret_env])).toEqual([['grok-bot', 'WEBHOOK_SECRET_GROK'], ['other', 'WEBHOOK_SECRET_OTHER']]);
    expect(rows.every((r) => !('secret' in r))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/s-grok|s-other/);
  });

  it('a delivery signs with the secret from a mounted secret file (NAME_FILE)', async () => {
    const rx = await startReceiver();
    receivers.push(rx);
    const file = join(mkdtempSync(join(tmpdir(), 'jh-mounted-')), 'hook');
    writeFileSync(file, 'from-mounted-file\n', { mode: 0o600 });
    const { a } = await start([{ name: 'rx', url: rx.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_RX' }], { WEBHOOK_SECRET_RX_FILE: file });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => rx.received[0]);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('from-mounted-file', got));
  });
});

describe('POST /ui/api/webhooks — add', () => {
  it('adds the row naming its variable; answers no secret; reflects it at once', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'add', name: 'phone', url: 'http://127.0.0.1:4797/p', events: ['job.failed'], secretEnv: 'WEBHOOK_SECRET_PHONE' });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('secret');
    const sub = r.body.subscriptions.find((s: { name: string }) => s.name === 'phone');
    expect(sub).toMatchObject({ url: 'http://127.0.0.1:4797/p', events: ['job.failed'], active: true, secretEnv: 'WEBHOOK_SECRET_PHONE', secretProblem: 'WEBHOOK_SECRET_PHONE is not set' });
    expect(stored(a)).toEqual([...BEFORE, { name: 'phone', url: 'http://127.0.0.1:4797/p', events: ['job.failed'], secretEnv: 'WEBHOOK_SECRET_PHONE', active: true }]);
  });

  it('a subscription added from the UI signs with the secret the runtime gives that variable', async () => {
    const { a, token } = await start([], { WEBHOOK_SECRET_RX: 'given-by-runtime' });
    const rx = await startReceiver();
    receivers.push(rx);
    const r = await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_RX' });
    expect(r.status).toBe(200);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => rx.received[0]);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('given-by-runtime', got));
  });

  it('the first subscription, inactive', async () => {
    const { a, token } = await start();
    const r = await edit(a, token, { action: 'add', name: 'first', url: 'https://example.invalid/h', events: ['*'], secretEnv: 'WEBHOOK_SECRET_FIRST', active: false });
    expect(r.status).toBe(200);
    expect((await list(a)).subscriptions).toMatchObject([{ name: 'first', events: ['*'], active: false }]);
  });

  it('a name already there: 409, nothing written', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'add', name: 'other', url: 'http://127.0.0.1:1/x', events: ['*'], secretEnv: 'WEBHOOK_SECRET_X' });
    expect(r.status).toBe(409);
    expect(stored(a)).toEqual(BEFORE);
  });

  it.each([
    ['a non-http url', { url: 'ftp://127.0.0.1/x', events: ['*'] }, 'url'],
    ['an unknown event type', { url: 'http://127.0.0.1:1/x', events: ['job.exploded'] }, 'must be an event type or "*"'],
    ['no events', { url: 'http://127.0.0.1:1/x', events: [] }, 'events'],
  ])('%s: 400 naming the field, nothing written', async (_what, fields, message) => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'add', name: 'bad', secretEnv: 'WEBHOOK_SECRET_BAD', ...fields });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(message);
    expect(stored(a)).toEqual(BEFORE);
  });

  it('a secret in the body, no secretEnv, a variable outside WEBHOOK_SECRET_*, or a version: 400, nothing written', async () => {
    const { a, token } = await start(TWO);
    for (const extra of [{ secretEnv: 'WEBHOOK_SECRET_N', secret: 'mine' }, {}, { secretEnv: 'GITHUB_APP_PRIVATE_KEY' }, { secretEnv: 'HOPPER_DATABASE_URL' }, { secretEnv: 'WEBHOOK_SECRET_N', version: 'missing' }]) {
      const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], ...extra });
      expect(r.status).toBe(400);
    }
    expect(stored(a)).toEqual(BEFORE);
  });
});

describe('POST /ui/api/webhooks — edit', () => {
  it('changes url, events and active of one row; the other row and the variable stay', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'edit', name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.find((s: { name: string }) => s.name === 'other')).toMatchObject({ url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    expect(stored(a)).toEqual([BEFORE[0], { name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], secretEnv: 'WEBHOOK_SECRET_OTHER', active: false }]);
  });

  it('only the fields sent change; the id stays', async () => {
    const { a, token } = await start(TWO);
    const id = a.user().store.webhooks.list()[0]!.id;
    const r = await edit(a, token, { action: 'edit', name: 'grok-bot', active: false });
    expect(r.status).toBe(200);
    expect(stored(a)).toEqual([{ ...BEFORE[0], active: false }, BEFORE[1]]);
    expect(a.user().store.webhooks.list()[0]!.id).toBe(id);
  });

  it('no such name: 404; a name, secret, secretEnv or bad url in the body: 400', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'edit', name: 'nope', active: false })).status).toBe(404);
    expect((await edit(a, token, { action: 'edit', name: 'other', newName: 'x' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secret: 'x' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secretEnv: 'WEBHOOK_SECRET_Y' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', url: 'not a url' })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', events: ['job.exploded'] })).status).toBe(400);
    expect(stored(a)).toEqual(BEFORE);
  });

  it('rotate-secret is gone: a secret is rotated where the runtime keeps it (400)', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'rotate-secret', name: 'grok-bot' })).status).toBe(400);
    expect(stored(a)).toEqual(BEFORE);
  });
});

describe('POST /ui/api/webhooks — remove', () => {
  it('drops the row; the other stays', async () => {
    const { a, token } = await start(TWO);
    const r = await edit(a, token, { action: 'remove', name: 'other' });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot']);
    expect(stored(a)).toEqual([BEFORE[0]]);
  });

  it('no such name: 404', async () => {
    const { a, token } = await start(TWO);
    expect((await edit(a, token, { action: 'remove', name: 'nope' })).status).toBe(404);
  });
});

describe('subscriptions survive a restart', () => {
  it('a subscription added from the UI is there after the daemon restarts on the same database', async () => {
    const { a, token } = await start();
    expect((await edit(a, token, { action: 'add', name: 'kept', url: 'http://127.0.0.1:1/k', events: ['*'], secretEnv: 'WEBHOOK_SECRET_KEPT' })).status).toBe(200);
    const dbPath = a.dbPath;
    await a.stop();
    t = await startTestApp({ dbPath, secrets: { ...RUNTIME } });
    expect((await list(t)).subscriptions.map((s: { name: string }) => s.name)).toEqual(['kept']);
  });
});

describe('POST /ui/api/webhooks — the guard', () => {
  it('without a UI session: 403, nothing changed', async () => {
    const { a } = await start(TWO);
    const r = await a.ui('/ui/api/webhooks', { action: 'remove', name: 'other' });
    expect(r.status).toBe(403);
    expect(stored(a)).toEqual(BEFORE);
  });
});

// Issue #378: a test event checks the URL and the secret without waiting for a real event.
describe('POST /ui/api/webhooks/test — Send test event', () => {
  it('posts one signed test event to the subscription and answers the HTTP result; no delivery is stored', async () => {
    const r = await startReceiver();
    receivers.push(r);
    const { a, token } = await start([{ name: 'hook', url: r.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_GROK' }]);
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 200 });
    expect(r.received).toHaveLength(1);
    const got = r.received[0]!;
    expect(got.headers['x-hopper-event']).toBe('webhook.test');
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('s-grok', got));
    expect(JSON.parse(got.body)).toMatchObject({ type: 'webhook.test', data: { test: true, subscription: 'hook' } });
    expect(a.user().store.webhooks.listDeliveries({ limit: 10 })).toEqual([]);
  });

  it('a receiver refusing it: ok false with its status', async () => {
    const r = await startReceiver(401);
    receivers.push(r);
    const { a, token } = await start([{ name: 'hook', url: r.url, events: ['*'], secretEnv: 'WEBHOOK_SECRET_GROK' }]);
    expect((await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token })).body).toMatchObject({ ok: false, status: 401 });
  });

  it('its secret unset: nothing sent, the answer says why; no such name: 404; no session: 403', async () => {
    const r = await startReceiver();
    receivers.push(r);
    const { a, token } = await start([{ name: 'hook', url: r.url, events: ['*'], secretEnv: 'WEBHOOK_SECRET_NONE' }]);
    const res = await a.ui<Record<string, unknown>>('/ui/api/webhooks/test', { name: 'hook' }, { token });
    expect(res.body).toMatchObject({ ok: false, detail: 'WEBHOOK_SECRET_NONE is not set' });
    expect(r.received).toHaveLength(0);
    expect((await a.ui('/ui/api/webhooks/test', { name: 'nope' }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/webhooks/test', { name: 'hook' })).status).toBe(403);
  });
});
