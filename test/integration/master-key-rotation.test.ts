// Issue #659 requirement 6, through the real composition root and the real HTTP server: the hopper's admin rotates the
// master key with one command (UI, API, CLI). Every secret the hopper keeps is sealed again under a new key in one
// transaction, the new key is shown once, and the running hopper goes on under it. The old key opens nothing after.
//
// Feature: rotate the master key
//   Scenario: rotate from the UI: every secret is sealed again under a new key, shown once; the running hopper keeps working
//   Scenario: after a rotation, a start with the old key is refused and says the key was rotated; the new key opens everything
//   Scenario: only the hopper's admin may rotate
//   Scenario: `hopper master-key rotate` prints the new key once, and no log line carries it
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { fingerprintOf } from '../../src/secrets/master-key.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'vault-value-659-rotation-0123456789';
const HOOK_SECRET = 'hook-secret-659-rotation-0123456789abcdef';

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

const freshDb = (): string => {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return db.dbPath;
};

async function boot(dbPath: string, secrets: Record<string, string | undefined>): Promise<{ a: TestApp; session: string }> {
  await t?.stop();
  t = undefined;
  t = await startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: undefined, ...secrets } });
  return { a: t, session: await t.login() };
}

type Rotated = { source: string; fingerprint?: string; saved: boolean; revealable: boolean; key?: string; resealed?: number; error?: string };
const rotate = (a: TestApp, session: string) => a.ui<Rotated>('/ui/api/master-key', { action: 'rotate' }, { token: session });
const setSecret = (a: TestApp, session: string, name: string, value: string) => a.ui<{ error?: string }>('/ui/api/vault', { action: 'set', name, value }, { token: session });
const addHook = (a: TestApp, session: string) => a.ui<{ error?: string }>('/ui/api/webhooks', { action: 'add', name: 'hook', url: 'http://127.0.0.1:1/h', events: ['*'], secret: HOOK_SECRET }, { token: session });

/** Every sealed row of every vault in the database: the instance's and the owner's. */
function sealedRows(dbPath: string): { id: string; name: string; sealed: string }[] {
  const rows: { id: string; name: string; sealed: string }[] = [];
  for (const url of [databaseUrlFor(dbPath), ownerSchemaUrlFor(dbPath)]) {
    const db = openDb(url);
    try {
      for (const r of db.all('SELECT id, name, sealed FROM vault_secrets WHERE sealed IS NOT NULL')) rows.push({ id: String(r.id), name: String(r.name), sealed: String(r.sealed) });
    } finally { db.close(); }
  }
  return rows;
}

const openRow = (key: string, row: { id: string; sealed: string }): string => createSealer(key).open(row.sealed, `vault:${row.id}/value`);

function instanceSettings(dbPath: string): Record<string, string> {
  const db = openDb(databaseUrlFor(dbPath));
  try { return Object.fromEntries(db.all('SELECT key, value FROM settings').map((r) => [String(r.key), String(r.value)])); } finally { db.close(); }
}

describe('rotating the master key (issue #659)', () => {
  it('from the UI: every secret is sealed again under a new key, shown once; the running hopper keeps working under it', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    expect((await setSecret(a, session, 'DEPLOY_KEY', VALUE)).status).toBe(200);
    expect((await addHook(a, session)).status).toBe(200);
    const before = sealedRows(dbPath);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const r = await rotate(a, session);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const key = r.body.key!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(KEY);
    expect(r.body).toMatchObject({ source: 'rotated', fingerprint: fingerprintOf(key).slice(0, 16), saved: false, revealable: false, resealed: before.length });
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(key));

    // Every row is under the new key now, with its value unchanged; the old key opens none.
    const after = sealedRows(dbPath);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
    for (const row of after) {
      expect(row.sealed.split('.')[1]).toBe(createSealer(key).keyId);
      const was = before.find((x) => x.id === row.id)!;
      expect(openRow(key, row)).toBe(openRow(KEY, was));
      expect(() => openRow(KEY, row)).toThrow();
    }

    // Shown once: the answer carries it, nothing else does.
    const view = (await a.api('GET', '/api/master-key')).body as Rotated;
    expect(view).toMatchObject({ source: 'rotated', saved: false, revealable: false });
    expect(JSON.stringify(view)).not.toContain(key);
    expect((await a.ui('/ui/api/master-key', { action: 'reveal' }, { token: session })).status).toBe(409);
    for (const text of logged) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(KEY);
    }

    // The running hopper seals and opens under the new key.
    expect((await setSecret(a, session, 'OTHER_KEY', 'other-value-0123456789')).status).toBe(200);
    const other = sealedRows(dbPath).find((x) => x.name === 'OTHER_KEY')!;
    expect(openRow(key, other)).toBe('other-value-0123456789');
    const hooks = (await a.api('GET', '/api/webhooks')).body as { subscriptions: { name: string; secretProblem?: string }[] };
    expect(hooks.subscriptions.find((s) => s.name === 'hook')?.secretProblem).toBeUndefined();
    expect(((await a.api('GET', '/api/vault')).body as { problem?: string }).problem).toBeUndefined();

    // The banner asks to save it until the admin says so.
    expect((await a.ui<Rotated>('/ui/api/master-key', { action: 'saved' }, { token: session })).body).toMatchObject({ source: 'rotated', saved: true });
    expect(instanceSettings(dbPath).masterKeySaved).toBe(fingerprintOf(key));
  });

  it('after a rotation, a start with the old key is refused and says the key was rotated; the new key opens everything', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await setSecret(a, session, 'DEPLOY_KEY', VALUE);
    const key = (await rotate(a, session)).body.key!;
    await a.stop();
    t = undefined;
    const settings = instanceSettings(dbPath);
    const rows = sealedRows(dbPath);

    await expect(startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: KEY } })).rejects.toThrow(/the master key does not match this database.*rotated/);
    expect(instanceSettings(dbPath)).toEqual(settings);
    expect(sealedRows(dbPath)).toEqual(rows);

    const { a: again } = await boot(dbPath, { HOPPER_MASTER_KEY: key });
    expect(((await again.api('GET', '/api/master-key')).body as Rotated)).toMatchObject({ source: 'given', saved: true });
    const row = sealedRows(dbPath).find((x) => x.name === 'DEPLOY_KEY')!;
    expect(openRow(key, row)).toBe(VALUE);
  });

  it('only the hopper\'s admin may rotate; nothing changes', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await setSecret(a, session, 'DEPLOY_KEY', VALUE);
    const user = await a.addUser('someone');
    const theirs = await a.login(user.id);
    const refused = await rotate(a, theirs);
    expect(refused.status).toBe(403);
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(KEY));
  });

  it('hopper master-key rotate: prints the new key once, as JSON; no log line carries it', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await setSecret(a, session, 'DEPLOY_KEY', VALUE);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['master-key', 'rotate', '--url', a.url], { env: { HOPPER_DATABASE_URL: databaseUrlFor(dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) });
    expect(code, err.join('')).toBe(0);
    const answer = JSON.parse(out.join('')) as { key: string; fingerprint: string; resealed: number };
    expect(answer.fingerprint).toBe(fingerprintOf(answer.key).slice(0, 16));
    expect(answer.resealed).toBeGreaterThanOrEqual(1);
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(answer.key));
    for (const text of [...logged, err.join('')]) expect(text).not.toContain(answer.key);
    const row = sealedRows(dbPath).find((x) => x.name === 'DEPLOY_KEY')!;
    expect(openRow(answer.key, row)).toBe(VALUE);
  });
});
