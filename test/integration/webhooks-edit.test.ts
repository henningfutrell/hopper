// Issue #18: webhook subscriptions are edited from the UI. The webhooks.yaml document stays the source of
// truth: POST /ui/api/webhooks rewrites one entry of it (comments and every other entry as written,
// against the document's version), and the store reflects it before the answer.
// Issue #56: every secret comes from the runtime. A subscription names the variable its secret is in
// (`secretEnv`); the hopper makes, stores and hands out no secret — not in the document, not in the
// store, not in an answer. A UI session may name only a `WEBHOOK_SECRET_*` variable, so it can never
// point a subscription at another credential the runtime holds.
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { readDocument, writeDocument } from '../support/files.ts';
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

const COMMENTED = `version: 1
# The owner's note: kept across UI edits
webhooks:
  # the bot, first
  - name: grok-bot
    url: http://127.0.0.1:4795/hook   # loopback only
    events: ["question.escalated", "job.finished"]
    secretEnv: WEBHOOK_SECRET_GROK
    active: true
  - name: other
    url: http://127.0.0.1:4796/other
    events: ["*"]
    secretEnv: WEBHOOK_SECRET_OTHER
`;
const GROK_BLOCK = COMMENTED.slice(COMMENTED.indexOf('  # the bot, first'), COMMENTED.indexOf('  - name: other'));
const RUNTIME = { WEBHOOK_SECRET_GROK: 's-grok', WEBHOOK_SECRET_OTHER: 's-other' };

/** `webhooksYaml` as text; `secrets` is the runtime's environment. */
async function start(webhooksYaml?: string, secrets: Record<string, string> = { ...RUNTIME }): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (webhooksYaml !== undefined) writeDocument(db.dbPath, 'webhooks.yaml', webhooksYaml);
  // A watcher that would not notice the edit for a minute: the store must reflect it anyway.
  t = await startTestApp({ dbPath: db.dbPath, seams: { webhookConfigIntervalMs: 60_000 }, secrets });
  return { a: t, token: await t.login() };
}

const read = (a: TestApp) => readDocument(a.dbPath, 'webhooks.yaml') as string;
/** Every row of the store's subscriptions, as stored. */
const storedRows = (a: TestApp): Record<string, unknown>[] => {
  const db = openDb(databaseUrlFor(a.dbPath));
  try {
    return db.all('SELECT * FROM webhooks');
  } finally {
    db.close();
  }
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const list = async (a: TestApp) => (await a.api('GET', '/api/webhooks')).body;
const version = async (a: TestApp) => (await list(a)).config.version as string;
const edit = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, any>>('/ui/api/webhooks', body, { token }); // eslint-disable-line @typescript-eslint/no-explicit-any
const signatureOf = (secret: string, got: { headers: Record<string, unknown>; body: string }) =>
  `sha256=${createHmac('sha256', secret).update(`${String(got.headers['x-hopper-timestamp'])}.${got.body}`).digest('hex')}`;

describe('GET /api/webhooks: what the UI edits', () => {
  it('carries the document version, each subscription\'s variable and whether the runtime provides it; never a secret', async () => {
    const { a } = await start(COMMENTED, { WEBHOOK_SECRET_GROK: 's-grok' });
    const body = await list(a);
    expect(body.config.version).toBe(sha(read(a)));
    expect(JSON.stringify(body)).not.toContain('s-grok');
    expect(body.subscriptions.map((s: Record<string, unknown>) => [s.name, s.secretEnv, s.secretProblem])).toEqual([
      ['grok-bot', 'WEBHOOK_SECRET_GROK', undefined],
      ['other', 'WEBHOOK_SECRET_OTHER', 'WEBHOOK_SECRET_OTHER is not set'],
    ]);
    expect(body.subscriptions.every((s: object) => !('secret' in s))).toBe(true);
  });

  it('is missing when there is no webhooks.yaml document', async () => {
    const { a } = await start();
    expect(await version(a)).toBe('missing');
  });
});

describe('secrets come from the runtime (issue #56)', () => {
  it('the store keeps no secret: each subscription row holds the variable name only', async () => {
    const { a } = await start(COMMENTED);
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
    const { a } = await start(`version: 1\nwebhooks:\n  - name: rx\n    url: ${rx.url}\n    events: ["job.finished"]\n    secretEnv: WEBHOOK_SECRET_RX\n`,
      { WEBHOOK_SECRET_RX_FILE: file });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => rx.received[0]);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('from-mounted-file', got));
  });

  it('an inline secret in the document is refused at load, never used or kept in the store', async () => {
    const { a } = await start('version: 1\nwebhooks:\n  - name: x\n    url: http://127.0.0.1:1/x\n    events: ["*"]\n    secret: inline\n');
    const body = await list(a);
    expect(body.config.error).toMatch(/secretEnv/);
    expect(body.subscriptions).toEqual([]);
    expect(JSON.stringify(storedRows(a))).not.toContain('inline');
  });
});

describe('POST /ui/api/webhooks — add', () => {
  it('appends the entry naming its variable; answers no secret; reflects it at once', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'phone', url: 'http://127.0.0.1:4797/p', events: ['job.failed'], secretEnv: 'WEBHOOK_SECRET_PHONE', version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('secret');
    const sub = r.body.subscriptions.find((s: { name: string }) => s.name === 'phone');
    expect(sub).toMatchObject({ url: 'http://127.0.0.1:4797/p', events: ['job.failed'], active: true, secretEnv: 'WEBHOOK_SECRET_PHONE', secretProblem: 'WEBHOOK_SECRET_PHONE is not set' });
    expect((await list(a)).subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot', 'other', 'phone']);
    const text = read(a);
    expect(text.startsWith(COMMENTED)).toBe(true);
    expect(text.slice(COMMENTED.length)).toBe('  - name: phone\n    url: http://127.0.0.1:4797/p\n    events: ["job.failed"]\n    secretEnv: WEBHOOK_SECRET_PHONE\n    active: true\n');
  });

  it('a subscription added from the UI signs with the secret the runtime gives that variable', async () => {
    const { a, token } = await start(undefined, { WEBHOOK_SECRET_RX: 'given-by-runtime' });
    const rx = await startReceiver();
    receivers.push(rx);
    const r = await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_RX', version: 'missing' });
    expect(r.status).toBe(200);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => rx.received[0]);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf('given-by-runtime', got));
  });

  it('with no document: writes version 1 and the one entry', async () => {
    const { a, token } = await start();
    expect(readDocument(a.dbPath, 'webhooks.yaml')).toBeUndefined();
    const r = await edit(a, token, { action: 'add', name: 'first', url: 'https://example.invalid/h', events: ['*'], secretEnv: 'WEBHOOK_SECRET_FIRST', active: false, version: 'missing' });
    expect(r.status).toBe(200);
    expect((await list(a)).subscriptions).toMatchObject([{ name: 'first', events: ['*'], active: false }]);
  });

  it('a name already there: 409, nothing written', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'other', url: 'http://127.0.0.1:1/x', events: ['*'], secretEnv: 'WEBHOOK_SECRET_X', version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(a)).toBe(COMMENTED);
  });

  it.each([
    ['a non-http url', { url: 'ftp://127.0.0.1/x', events: ['*'] }, 'url'],
    ['an unknown event type', { url: 'http://127.0.0.1:1/x', events: ['job.exploded'] }, 'must be an event type or "*"'],
    ['no events', { url: 'http://127.0.0.1:1/x', events: [] }, 'events'],
  ])('%s: 400 with the webhooks.yaml message, nothing written', async (_what, fields, message) => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'bad', secretEnv: 'WEBHOOK_SECRET_BAD', ...fields, version: await version(a) });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(message);
    expect(read(a)).toBe(COMMENTED);
  });

  it('a secret in the body, no secretEnv, or a variable outside WEBHOOK_SECRET_*: 400, nothing written', async () => {
    const { a, token } = await start(COMMENTED);
    const v = await version(a);
    for (const extra of [{ secretEnv: 'WEBHOOK_SECRET_N', secret: 'mine' }, {}, { secretEnv: 'GITHUB_APP_PRIVATE_KEY' }, { secretEnv: 'HOPPER_DATABASE_URL' }]) {
      const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], version: v, ...extra });
      expect(r.status).toBe(400);
    }
    expect(read(a)).toBe(COMMENTED);
  });
});

describe('POST /ui/api/webhooks — edit', () => {
  it('changes url, events and active of one entry; comments and the other entry stay byte for byte', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'edit', name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false, version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.find((s: { name: string }) => s.name === 'other')).toMatchObject({ url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    const text = read(a);
    expect(text).toContain("# The owner's note: kept across UI edits");
    expect(text).toContain(GROK_BLOCK);
    expect(text).toContain('secretEnv: WEBHOOK_SECRET_OTHER');
    expect(a.app.store.webhooks.list().find((s) => s.name === 'other')).toMatchObject({ active: false });
  });

  it('only the fields sent change', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'edit', name: 'grok-bot', active: false, version: await version(a) });
    expect(r.status).toBe(200);
    expect(read(a)).toBe(COMMENTED.replace('    active: true\n', '    active: false\n'));
  });

  it('a stale version: 409, nothing written', async () => {
    const { a, token } = await start(COMMENTED);
    const v = await version(a);
    const changed = COMMENTED.replace('4796/other', '4796/other-2');
    writeDocument(a.dbPath, 'webhooks.yaml', changed);
    const r = await edit(a, token, { action: 'edit', name: 'other', active: false, version: v });
    expect(r.status).toBe(409);
    expect(read(a)).toBe(changed);
  });

  it('no such name: 404; a name, secret or secretEnv in the body: 400', async () => {
    const { a, token } = await start(COMMENTED);
    const v = await version(a);
    expect((await edit(a, token, { action: 'edit', name: 'nope', active: false, version: v })).status).toBe(404);
    expect((await edit(a, token, { action: 'edit', name: 'other', newName: 'x', version: v })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secret: 'x', version: v })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secretEnv: 'WEBHOOK_SECRET_Y', version: v })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', url: 'not a url', version: v })).status).toBe(400);
  });

  it('an invalid webhooks.yaml is never edited from the UI: 409', async () => {
    const { a, token } = await start('version: 1\nwebhooks:\n  - name: x\n');
    const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], secretEnv: 'WEBHOOK_SECRET_N', version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(a)).toBe('version: 1\nwebhooks:\n  - name: x\n');
  });

  it('rotate-secret is gone: a secret is rotated where the runtime keeps it (400)', async () => {
    const { a, token } = await start(COMMENTED);
    expect((await edit(a, token, { action: 'rotate-secret', name: 'grok-bot', version: await version(a) })).status).toBe(400);
    expect(read(a)).toBe(COMMENTED);
  });
});

describe('POST /ui/api/webhooks — remove', () => {
  it('drops the entry and its subscription; the rest of the document as written', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'remove', name: 'other', version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot']);
    expect(a.app.store.webhooks.list().map((s) => s.name)).toEqual(['grok-bot']);
    const text = read(a);
    expect(text).toContain(GROK_BLOCK);
    expect(text).not.toContain('other');
  });

  it('no such name: 404', async () => {
    const { a, token } = await start(COMMENTED);
    expect((await edit(a, token, { action: 'remove', name: 'nope', version: await version(a) })).status).toBe(404);
  });
});

describe('POST /ui/api/webhooks — the guard', () => {
  it('without a UI session: 403, document unchanged', async () => {
    const { a } = await start(COMMENTED);
    const r = await a.ui('/ui/api/webhooks', { action: 'remove', name: 'other', version: await version(a) });
    expect(r.status).toBe(403);
    expect(read(a)).toBe(COMMENTED);
  });
});
