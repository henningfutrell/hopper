// Issue #558, slice 1, through the real composition root and the real HTTP server: write-only vault secrets. A secret
// is set once in the UI and never read back — by no route, to no role —, kept sealed in the user's store under the
// master key, and its value never reaches an event, a log line or an error (design.md "The vault").
//
// Feature: write-only vault secrets
//   Scenario: a secret set in the UI is never answered back
//     Given a hopper with a master key and an admin signed in
//     When the admin sets the vault secret DEPLOY_KEY with its scope
//     Then the vault lists DEPLOY_KEY with its scope, who set it and when — and no value
//     And the database holds it only sealed
//   Scenario: no read route answers a value: each one the API reference documents is asked, and none carries it
//   Scenario: replace keeps the secret and changes its value; remove deletes it
//   Scenario: a name that is no secret name, or an empty value, is refused, saying why, without the value
//   Scenario: no UI session, or no admin: refused
//   Scenario: no master key: nothing is stored, and the answer says why
//   Scenario: a new master key with the old one as previous seals every vault secret again at start
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openApiDocument } from '../../src/http/openapi.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { ownerSchemaUrlFor } from '../support/database.ts';
import { rawRequest } from '../support/http.ts';
import { KEY, NEW_KEY } from '../support/webhooks.ts';

const VALUE = 'vault-value-0123456789abcdef-never-read-back';
const OTHER = 'other-value-fedcba9876543210-never-read-back';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
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
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function boot(secrets: Record<string, string | undefined> = { HOPPER_MASTER_KEY: KEY }, dbPath?: string): Promise<{ a: TestApp; session: string }> {
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath, secrets });
  return { a: t, session: await t.login() };
}

type View = { secrets: Record<string, unknown>[]; problem?: string };
const vault = async (a: TestApp): Promise<View> => (await a.api('GET', '/api/vault')).body as View;
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<View & { error?: string }>('/ui/api/vault', body, { token: session });

/** The vault's table as the database holds it. */
function rows(a: TestApp): Record<string, unknown>[] {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { return db.all('SELECT * FROM vault_secrets ORDER BY seq'); } finally { db.close(); }
}

/** Nothing the hopper answered, logged, appended or stored in clear carries `value`. */
async function nowhere(a: TestApp, value: string): Promise<void> {
  expect(JSON.stringify(await vault(a))).not.toContain(value);
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(JSON.stringify(rows(a))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
}

describe('write-only vault secrets', () => {
  it('a secret set in the UI is never answered back: metadata only, sealed in the database', async () => {
    const { a, session } = await boot();
    const r = await rawRequest(a.url, {
      method: 'POST', path: '/ui/api/vault', headers: { 'content-type': 'application/json', origin: a.url, 'x-hopper-session': session },
      body: JSON.stringify({ action: 'set', name: 'DEPLOY_KEY', scope: 'k3s lab, namespace default', value: VALUE }),
    });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text).not.toContain(VALUE);
    const [s] = (await vault(a)).secrets;
    expect(s).toMatchObject({ name: 'DEPLOY_KEY', scope: 'k3s lab, namespace default', setBy: expect.any(String), createdAt: expect.any(String), changedAt: expect.any(String) });
    expect(Object.keys(s!).sort()).toEqual(['changedAt', 'changedBy', 'createdAt', 'id', 'name', 'scope', 'setBy']);
    const [row] = rows(a);
    expect(String(row!.sealed)).toMatch(/^hs1\./);
    expect(createSealer(KEY).open(String(row!.sealed), `vault:${String(row!.id)}/value`)).toBe(VALUE);
    expect((await a.events()).map((e) => e.type)).toContain('vault.secret_set');
    await nowhere(a, VALUE);
  });

  it('no read route answers a value: every one the API reference documents is asked, with an admin session', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    const paths = openApiDocument('test').paths as Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
    const reads = Object.entries(paths).filter(([p, ops]) => ops.get && !p.includes('{') && !ops.get.responses['200']?.content?.['text/event-stream']).map(([p]) => p);
    expect(reads).toContain('/api/vault');
    for (const path of reads) {
      const r = await rawRequest(a.url, { path, headers: { 'x-hopper-session': session } });
      expect(r.text, path).not.toContain(VALUE);
    }
  });

  it('replace keeps the secret, changes its value and when; remove deletes it', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    const before = (await vault(a)).secrets[0]!;
    await new Promise((r) => setTimeout(r, 5));
    await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: OTHER });
    const after = (await vault(a)).secrets[0]!;
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.changedAt).not.toBe(before.changedAt);
    const [row] = rows(a);
    expect(createSealer(KEY).open(String(row!.sealed), `vault:${String(row!.id)}/value`)).toBe(OTHER);
    expect((await edit(a, session, { action: 'remove', name: 'DEPLOY_KEY' })).status).toBe(200);
    expect((await vault(a)).secrets).toEqual([]);
    expect(rows(a)).toEqual([]);
    expect((await edit(a, session, { action: 'remove', name: 'DEPLOY_KEY' })).status).toBe(404);
    await nowhere(a, VALUE);
    await nowhere(a, OTHER);
  });

  it('a name that is no secret name, or an empty value, is refused, saying why, without the value', async () => {
    const { a, session } = await boot();
    const bad = await edit(a, session, { action: 'set', name: '1bad', value: VALUE });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(VALUE);
    expect((await edit(a, session, { action: 'set', name: 'GOOD', value: '' })).status).toBe(400);
    expect(rows(a)).toEqual([]);
    await nowhere(a, VALUE);
  });

  it('without a UI session: refused', async () => {
    const { a } = await boot();
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'DEPLOY_KEY', value: VALUE })).status).toBe(403);
    expect(rows(a)).toEqual([]);
  });

  it('no master key (limited, issue #659): nothing is stored, and the answer says why', async () => {
    const { a: first } = await boot();
    const dbPath = first.dbPath;
    await first.stop();
    t = undefined;
    const { a, session } = await boot({ HOPPER_MASTER_KEY: undefined }, dbPath);
    const r = await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('the master key is missing');
    expect((await vault(a)).problem).toContain('HOPPER_MASTER_KEY');
    expect(rows(a)).toEqual([]);
  });

  it('a new master key with the old one as previous seals every vault secret again at start', async () => {
    const { a: first, session } = await boot();
    await edit(first, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    const dbPath = first.dbPath;
    await first.stop();
    t = undefined;
    const { a } = await boot({ HOPPER_MASTER_KEY: NEW_KEY, HOPPER_MASTER_KEY_PREVIOUS: KEY }, dbPath);
    const [row] = rows(a);
    expect(String(row!.sealed).split('.')[1]).toBe(createSealer(NEW_KEY).keyId);
    expect(createSealer(NEW_KEY).open(String(row!.sealed), `vault:${String(row!.id)}/value`)).toBe(VALUE);
    expect((await vault(a)).secrets[0]).toMatchObject({ name: 'DEPLOY_KEY' });
  });
});
