// Issue #18: webhook subscriptions are edited from the UI. The webhooks.yaml document stays the source of
// truth: POST /ui/api/webhooks rewrites one entry of it (comments and every other entry as written,
// against the document's version), and the store reflects it before the answer.
// A secret leaves the daemon once, in the answer to add or rotate-secret; no GET carries one.
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
    secret: "s-grok"
    active: true
  - name: other
    url: http://127.0.0.1:4796/other
    events: ["*"]
    secret: s-other
`;
const GROK_BLOCK = COMMENTED.slice(COMMENTED.indexOf('  # the bot, first'), COMMENTED.indexOf('  - name: other'));

/** `webhooksYaml` as text; `secrets` is the environment a `secretEnv` entry reads. */
async function start(webhooksYaml?: string, secrets?: Record<string, string>): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (webhooksYaml !== undefined) writeDocument(db.dbPath, 'webhooks.yaml', webhooksYaml);
  // A watcher that would not notice the edit for a minute: the store must reflect it anyway.
  t = await startTestApp({ dbPath: db.dbPath, seams: { webhookConfigIntervalMs: 60_000 }, ...(secrets ? { secrets } : {}) });
  return { a: t, token: await t.login() };
}

const read = (a: TestApp) => readDocument(a.dbPath, 'webhooks.yaml') as string;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const list = async (a: TestApp) => (await a.api('GET', '/api/webhooks')).body;
const version = async (a: TestApp) => (await list(a)).config.version as string;
const edit = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, any>>('/ui/api/webhooks', body, { token }); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('GET /api/webhooks: what the UI edits', () => {
  it('carries the document version (sha-256 of its text, or missing) and never a secret', async () => {
    const { a } = await start(COMMENTED);
    const body = await list(a);
    expect(body.config.version).toBe(sha(read(a)));
    expect(JSON.stringify(body)).not.toContain('s-grok');
    expect(body.subscriptions.every((s: object) => !('secret' in s) && !('secretEnv' in s))).toBe(true);
    expect(body.subscriptions.map((s: { secretSource: string }) => s.secretSource)).toEqual(body.subscriptions.map(() => 'inline'));
  });

  it('is missing when there is no webhooks.yaml document', async () => {
    const { a } = await start();
    expect(await version(a)).toBe('missing');
  });
});

describe('POST /ui/api/webhooks — add', () => {
  it('appends the entry with a generated secret, returns the secret once, reflects it at once', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'phone', url: 'http://127.0.0.1:4797/p', events: ['job.failed'], version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[0-9a-f]{64}$/);
    const sub = r.body.subscriptions.find((s: { name: string }) => s.name === 'phone');
    expect(sub).toMatchObject({ url: 'http://127.0.0.1:4797/p', events: ['job.failed'], active: true });
    expect(sub).not.toHaveProperty('secret');
    // The store, not only the answer, has it before the watcher could have looked.
    expect((await list(a)).subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot', 'other', 'phone']);
    expect(a.app.store.webhooks.list().find((s) => s.name === 'phone')?.secret).toBe(r.body.secret);
    // Inline in the document, everything else as written.
    const text = read(a);
    expect(text.startsWith(COMMENTED)).toBe(true);
    expect(text).toContain(`secret: ${r.body.secret}`);
    expect(JSON.stringify(await list(a))).not.toContain(r.body.secret);
  });

  it('a subscription added from the UI is signed with the secret the answer gave', async () => {
    const { a, token } = await start();
    const rx = await startReceiver();
    receivers.push(rx);
    const r = await edit(a, token, { action: 'add', name: 'rx', url: rx.url, events: ['job.finished'], version: 'missing' });
    expect(r.status).toBe(200);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => rx.received[0]);
    const ts = String(got.headers['x-jobhopper-timestamp']);
    const mac = createHmac('sha256', r.body.secret).update(`${ts}.${got.body}`).digest('hex');
    expect(got.headers['x-jobhopper-signature']).toBe(`sha256=${mac}`);
  });

  it('with no document: writes version 1 and the one entry', async () => {
    const { a, token } = await start();
    expect(readDocument(a.dbPath, 'webhooks.yaml')).toBeUndefined();
    const r = await edit(a, token, { action: 'add', name: 'first', url: 'https://example.invalid/h', events: ['*'], active: false, version: 'missing' });
    expect(r.status).toBe(200);
    expect((await list(a)).subscriptions).toMatchObject([{ name: 'first', events: ['*'], active: false }]);
  });

  it('a name already there: 409, nothing written', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'other', url: 'http://127.0.0.1:1/x', events: ['*'], version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(a)).toBe(COMMENTED);
  });

  it.each([
    ['a non-http url', { url: 'ftp://127.0.0.1/x', events: ['*'] }, 'url'],
    ['an unknown event type', { url: 'http://127.0.0.1:1/x', events: ['job.exploded'] }, 'must be an event type or "*"'],
    ['no events', { url: 'http://127.0.0.1:1/x', events: [] }, 'events'],
  ])('%s: 400 with the webhooks.yaml message, nothing written', async (_what, fields, message) => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'bad', ...fields, version: await version(a) });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(message);
    expect(read(a)).toBe(COMMENTED);
  });

  it('a secret or secretEnv in the body: 400 (the daemon makes secrets; secretEnv is document-only)', async () => {
    const { a, token } = await start(COMMENTED);
    const v = await version(a);
    for (const extra of [{ secret: 'mine' }, { secretEnv: 'X' }]) {
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
    expect(r.body).not.toHaveProperty('secret');
    expect(r.body.subscriptions.find((s: { name: string }) => s.name === 'other')).toMatchObject({ url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    const text = read(a);
    expect(text).toContain("# The owner's note: kept across UI edits");
    expect(text).toContain(GROK_BLOCK);
    expect(text).toContain('secret: s-other');
    expect(a.app.store.webhooks.list().find((s) => s.name === 'other')).toMatchObject({ active: false, secret: 's-other' });
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
    const changed = COMMENTED.replace('s-other', 's-other-2');
    writeDocument(a.dbPath, 'webhooks.yaml', changed);
    const r = await edit(a, token, { action: 'edit', name: 'other', active: false, version: v });
    expect(r.status).toBe(409);
    expect(read(a)).toBe(changed);
  });

  it('no such name: 404; a name or secret in the body: 400', async () => {
    const { a, token } = await start(COMMENTED);
    const v = await version(a);
    expect((await edit(a, token, { action: 'edit', name: 'nope', active: false, version: v })).status).toBe(404);
    expect((await edit(a, token, { action: 'edit', name: 'other', newName: 'x', version: v })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', secret: 'x', version: v })).status).toBe(400);
    expect((await edit(a, token, { action: 'edit', name: 'other', url: 'not a url', version: v })).status).toBe(400);
  });

  it('an invalid webhooks.yaml is never edited from the UI: 409', async () => {
    const { a, token } = await start('version: 1\nwebhooks:\n  - name: x\n');
    const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(a)).toBe('version: 1\nwebhooks:\n  - name: x\n');
  });
});

describe('POST /ui/api/webhooks — rotate-secret', () => {
  it('writes a new secret, returns it once, the store signs with it', async () => {
    const { a, token } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'rotate-secret', name: 'grok-bot', version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(read(a)).toBe(COMMENTED.replace('"s-grok"', r.body.secret));
    expect(a.app.store.webhooks.list().find((s) => s.name === 'grok-bot')?.secret).toBe(r.body.secret);
    expect(JSON.stringify(await list(a))).not.toContain(r.body.secret);
  });

  it('an entry with secretEnv: 409, the document untouched', async () => {
    const yaml = 'version: 1\nwebhooks:\n  - name: f\n    url: http://127.0.0.1:1/f\n    events: ["*"]\n    secretEnv: WH_SECRET\n';
    const { a, token } = await start(yaml, { WH_SECRET: 'from-env' });
    const r = await edit(a, token, { action: 'rotate-secret', name: 'f', version: await version(a) });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('reads its secret from WH_SECRET');
    expect(read(a)).toBe(yaml);
    // The view says where each secret lives (never the variable's value), so the UI offers Rotate only inline.
    expect((await list(a)).subscriptions.find((s: { name: string }) => s.name === 'f').secretSource).toBe('env');
    expect(JSON.stringify(await list(a))).not.toContain('from-env');
    // Editing other fields of it keeps secretEnv as written.
    const e = await edit(a, token, { action: 'edit', name: 'f', active: false, version: await version(a) });
    expect(e.status).toBe(200);
    expect(read(a)).toContain('secretEnv: WH_SECRET');
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
