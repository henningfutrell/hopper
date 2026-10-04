// Issue #18: webhook subscriptions are edited from the UI. webhooks.yaml stays the source of truth:
// POST /ui/api/webhooks rewrites one entry of it (comments and every other entry as written,
// atomic, mode 600, against the file's version), and the store reflects it before the answer.
// A secret leaves the daemon once, in the answer to add or rotate-secret; no GET carries one.
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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

/** `webhooksYaml` as text, or made from the data dir (for a secretFile beside it). */
async function start(webhooksYaml?: string | ((dataDir: string) => string), mode = 0o600): Promise<{ a: TestApp; token: string; file: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const file = join(dirname(db.dbPath), 'webhooks.yaml');
  const text = typeof webhooksYaml === 'function' ? webhooksYaml(dirname(db.dbPath)) : webhooksYaml;
  if (text !== undefined) { writeFileSync(file, text); chmodSync(file, mode); }
  // A watcher that would not notice the edit for a minute: the store must reflect it anyway.
  t = await startTestApp({ dbPath: db.dbPath, seams: { webhookConfigIntervalMs: 60_000 } });
  return { a: t, token: await t.login(), file };
}

const read = (file: string) => readFileSync(file, 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const list = async (a: TestApp) => (await a.api('GET', '/api/webhooks')).body;
const version = async (a: TestApp) => (await list(a)).config.version as string;
const edit = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<Record<string, any>>('/ui/api/webhooks', body, { token }); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('GET /api/webhooks: what the UI edits', () => {
  it('carries the file version (sha-256 of its bytes, or missing) and never a secret', async () => {
    const { a, file } = await start(COMMENTED);
    const body = await list(a);
    expect(body.config.version).toBe(sha(read(file)));
    expect(JSON.stringify(body)).not.toContain('s-grok');
    expect(body.subscriptions.every((s: object) => !('secret' in s) && !('secretFile' in s))).toBe(true);
    expect(body.subscriptions.map((s: { secretSource: string }) => s.secretSource)).toEqual(body.subscriptions.map(() => 'inline'));
  });

  it('is missing when there is no webhooks.yaml', async () => {
    const { a } = await start();
    expect(await version(a)).toBe('missing');
  });
});

describe('POST /ui/api/webhooks — add', () => {
  it('appends the entry with a generated secret, returns the secret once, reflects it at once', async () => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'phone', url: 'http://127.0.0.1:4797/p', events: ['job.failed'], version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[0-9a-f]{64}$/);
    const sub = r.body.subscriptions.find((s: { name: string }) => s.name === 'phone');
    expect(sub).toMatchObject({ url: 'http://127.0.0.1:4797/p', events: ['job.failed'], active: true });
    expect(sub).not.toHaveProperty('secret');
    // The store, not only the answer, has it before the watcher could have looked.
    expect((await list(a)).subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot', 'other', 'phone']);
    expect(a.app.store.webhooks.list().find((s) => s.name === 'phone')?.secret).toBe(r.body.secret);
    // Inline in the file, everything else as written.
    const text = read(file);
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

  it('with no file: writes version 1 and the one entry, mode 600', async () => {
    const { a, token, file } = await start();
    expect(existsSync(file)).toBe(false);
    const r = await edit(a, token, { action: 'add', name: 'first', url: 'https://example.invalid/h', events: ['*'], active: false, version: 'missing' });
    expect(r.status).toBe(200);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await list(a)).subscriptions).toMatchObject([{ name: 'first', events: ['*'], active: false }]);
  });

  it('a name already there: 409, nothing written', async () => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'other', url: 'http://127.0.0.1:1/x', events: ['*'], version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(file)).toBe(COMMENTED);
  });

  it.each([
    ['a non-http url', { url: 'ftp://127.0.0.1/x', events: ['*'] }, 'url'],
    ['an unknown event type', { url: 'http://127.0.0.1:1/x', events: ['job.exploded'] }, 'must be an event type or "*"'],
    ['no events', { url: 'http://127.0.0.1:1/x', events: [] }, 'events'],
  ])('%s: 400 with the webhooks.yaml message, nothing written', async (_what, fields, message) => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'add', name: 'bad', ...fields, version: await version(a) });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(message);
    expect(read(file)).toBe(COMMENTED);
  });

  it('a secret or secretFile in the body: 400 (the daemon makes secrets; secretFile is file-only)', async () => {
    const { a, token, file } = await start(COMMENTED);
    const v = await version(a);
    for (const extra of [{ secret: 'mine' }, { secretFile: '/tmp/x' }]) {
      const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], version: v, ...extra });
      expect(r.status).toBe(400);
    }
    expect(read(file)).toBe(COMMENTED);
  });
});

describe('POST /ui/api/webhooks — edit', () => {
  it('changes url, events and active of one entry; comments and the other entry stay byte for byte; mode 600', async () => {
    const { a, token, file } = await start(COMMENTED, 0o644);
    const r = await edit(a, token, { action: 'edit', name: 'other', url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false, version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('secret');
    expect(r.body.subscriptions.find((s: { name: string }) => s.name === 'other')).toMatchObject({ url: 'http://127.0.0.1:4799/new', events: ['job.failed', 'job.finished'], active: false });
    const text = read(file);
    expect(text).toContain("# The owner's note: kept across UI edits");
    expect(text).toContain(GROK_BLOCK);
    expect(text).toContain('secret: s-other');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(a.app.store.webhooks.list().find((s) => s.name === 'other')).toMatchObject({ active: false, secret: 's-other' });
  });

  it('only the fields sent change', async () => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'edit', name: 'grok-bot', active: false, version: await version(a) });
    expect(r.status).toBe(200);
    expect(read(file)).toBe(COMMENTED.replace('    active: true\n', '    active: false\n'));
  });

  it('a stale version: 409, nothing written', async () => {
    const { a, token, file } = await start(COMMENTED);
    const v = await version(a);
    const changed = COMMENTED.replace('s-other', 's-other-2');
    writeFileSync(file, changed);
    const r = await edit(a, token, { action: 'edit', name: 'other', active: false, version: v });
    expect(r.status).toBe(409);
    expect(read(file)).toBe(changed);
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
    const { a, token, file } = await start('version: 1\nwebhooks:\n  - name: x\n');
    const r = await edit(a, token, { action: 'add', name: 'n', url: 'http://127.0.0.1:1/x', events: ['*'], version: await version(a) });
    expect(r.status).toBe(409);
    expect(read(file)).toBe('version: 1\nwebhooks:\n  - name: x\n');
  });
});

describe('POST /ui/api/webhooks — rotate-secret', () => {
  it('writes a new secret, returns it once, the store signs with it', async () => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'rotate-secret', name: 'grok-bot', version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(read(file)).toBe(COMMENTED.replace('"s-grok"', r.body.secret));
    expect(a.app.store.webhooks.list().find((s) => s.name === 'grok-bot')?.secret).toBe(r.body.secret);
    expect(JSON.stringify(await list(a))).not.toContain(r.body.secret);
  });

  it('an entry with secretFile: 409, the file and its secretFile untouched', async () => {
    let secretPath = '';
    let yaml = '';
    const { a, token, file } = await start((dataDir) => {
      secretPath = join(dataDir, 'grok.secret');
      writeFileSync(secretPath, 'from-file\n', { mode: 0o600 });
      yaml = `version: 1\nwebhooks:\n  - name: f\n    url: http://127.0.0.1:1/f\n    events: ["*"]\n    secretFile: ${secretPath}\n`;
      return yaml;
    });
    const r = await edit(a, token, { action: 'rotate-secret', name: 'f', version: await version(a) });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('secretFile');
    expect(read(file)).toBe(yaml);
    // The view says where each secret lives (never the path), so the UI offers Rotate only inline.
    expect((await list(a)).subscriptions.find((s: { name: string }) => s.name === 'f').secretSource).toBe('file');
    expect(JSON.stringify(await list(a))).not.toContain(secretPath);
    // Editing other fields of it keeps secretFile as written.
    const e = await edit(a, token, { action: 'edit', name: 'f', active: false, version: await version(a) });
    expect(e.status).toBe(200);
    expect(read(file)).toContain(`secretFile: ${secretPath}`);
  });
});

describe('POST /ui/api/webhooks — remove', () => {
  it('drops the entry and its subscription; the rest of the file as written', async () => {
    const { a, token, file } = await start(COMMENTED);
    const r = await edit(a, token, { action: 'remove', name: 'other', version: await version(a) });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions.map((s: { name: string }) => s.name)).toEqual(['grok-bot']);
    expect(a.app.store.webhooks.list().map((s) => s.name)).toEqual(['grok-bot']);
    const text = read(file);
    expect(text).toContain(GROK_BLOCK);
    expect(text).not.toContain('other');
  });

  it('no such name: 404', async () => {
    const { a, token } = await start(COMMENTED);
    expect((await edit(a, token, { action: 'remove', name: 'nope', version: await version(a) })).status).toBe(404);
  });
});

describe('POST /ui/api/webhooks — the guard', () => {
  it('without a UI session: 403, file unchanged', async () => {
    const { a, file } = await start(COMMENTED);
    const r = await a.ui('/ui/api/webhooks', { action: 'remove', name: 'other', version: await version(a) });
    expect(r.status).toBe(403);
    expect(read(file)).toBe(COMMENTED);
  });
});
