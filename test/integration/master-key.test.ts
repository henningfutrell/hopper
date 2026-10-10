// Issue #659, through the real composition root and the real HTTP server: the master key comes from the launch, never
// from a volume. Each restart here is a new daemon on the same database and nothing else — as a new container is.
//
// Feature: the master key does not depend on a persistent volume
//   Scenario: HOPPER_MASTER_KEY given: secrets seal and open, and a restart with the same key keeps them
//   Scenario: a first start with no key makes one and shows it once in the UI, never in the log; a second start without it is limited, and makes no new secret
//   Scenario: a wrong key stops the start, saying the key does not match; nothing in the database changes
//   Scenario: the old token key is moved: every secret stays readable, and once HOPPER_MASTER_KEY is set the old key can go
//   Scenario: `hopper master-key status` says the source, the fingerprint and whether a previous key is set, never a key (issue #685)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { fingerprintOf } from '../../src/secrets/master-key.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { KEY, NEW_KEY } from '../support/webhooks.ts';

const VALUE = 'vault-value-659-0123456789abcdef';

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

/** A daemon on `dbPath` with `secrets` (no master key unless given), and an admin session. */
async function boot(dbPath: string, secrets: Record<string, string | undefined>): Promise<{ a: TestApp; session: string }> {
  await t?.stop();
  t = undefined;
  t = await startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: undefined, ...secrets } });
  return { a: t, session: await t.login() };
}

type View = { secrets: Record<string, unknown>[]; problem?: string };
type KeyView = { source: string; fingerprint?: string; previous: boolean; saved: boolean; revealable: boolean; problem?: string; key?: string };
const vault = async (a: TestApp): Promise<View> => (await a.api('GET', '/api/vault')).body as View;
const setSecret = (a: TestApp, session: string, value = VALUE) => a.ui<View & { error?: string }>('/ui/api/vault', { action: 'set', name: 'DEPLOY_KEY', value }, { token: session });
const keyView = async (a: TestApp): Promise<KeyView> => (await a.api('GET', '/api/master-key')).body as KeyView;
const keyAct = (a: TestApp, session: string, action: string) => a.ui<KeyView & { error?: string }>('/ui/api/master-key', { action }, { token: session });

/** The value of DEPLOY_KEY as the daemon would open it: its stored row under `key`; undefined while the vault says it cannot. */
const opened = async (a: TestApp, key: string): Promise<string | undefined> => {
  if ((await vault(a)).problem !== undefined) return undefined;
  const [row] = vaultRows(a.dbPath);
  return createSealer(key).open(String(row!.sealed), `vault:${String(row!.id)}/value`);
};

function vaultRows(dbPath: string): Record<string, unknown>[] {
  const db = openDb(ownerSchemaUrlFor(dbPath));
  try { return db.all('SELECT * FROM vault_secrets ORDER BY seq'); } finally { db.close(); }
}

function instanceSettings(dbPath: string): Record<string, string> {
  const db = openDb(databaseUrlFor(dbPath));
  try { return Object.fromEntries(db.all('SELECT key, value FROM settings').map((r) => [String(r.key), String(r.value)])); } finally { db.close(); }
}

describe('the master key (issue #659)', () => {
  it('given as HOPPER_MASTER_KEY: secrets seal and open, and a new daemon with the same key keeps them', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    expect((await setSecret(a, session)).status).toBe(200);
    expect(await keyView(a)).toEqual({ source: 'given', fingerprint: fingerprintOf(KEY).slice(0, 16), previous: false, saved: true, revealable: false });
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(KEY));
    expect(logged.join('\n')).not.toContain(KEY);

    const { a: again } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    expect(await opened(again, KEY)).toBe(VALUE);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('a first start with no key makes one, shows it once in the UI and never in the log; a second start without it is limited', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, {});
    const fingerprint = instanceSettings(dbPath).masterKeyFingerprint!;
    expect(logged.filter((l) => l.includes(`master key: made for this new hopper (generated), fingerprint ${fingerprint.slice(0, 16)}`))).toHaveLength(1);
    expect(logged.some((l) => l.includes('SAVE THIS NOW'))).toBe(false);
    expect(await keyView(a)).toMatchObject({ source: 'generated', saved: false, revealable: true });

    // Only the hopper's admin sees it, once; a viewer may not ask.
    const revealed = await keyAct(a, session, 'reveal');
    expect(revealed.status).toBe(200);
    const key = revealed.body.key!;
    expect(fingerprintOf(key)).toBe(fingerprint);
    expect(logged.join('\n')).not.toContain(key);
    expect(JSON.stringify(await keyView(a))).not.toContain(key);
    expect((await keyAct(a, session, 'reveal')).status).toBe(409);
    expect(await keyView(a)).toMatchObject({ source: 'generated', saved: false, revealable: false });
    expect((await keyAct(a, session, 'saved')).body).toMatchObject({ source: 'generated', saved: true, revealable: false });
    expect(instanceSettings(dbPath).masterKeySaved).toBe(fingerprintOf(key));

    // The key it made seals, for this run.
    expect((await setSecret(a, session)).status).toBe(200);
    const before = vaultRows(dbPath);

    // A new container without the key: limited. It names the key, deletes nothing, makes no new key and stores no secret.
    logged = [];
    const { a: limited, session: s2 } = await boot(dbPath, {});
    expect(logged.some((l) => l.includes('SAVE THIS NOW'))).toBe(false);
    expect(logged.some((l) => l.includes('LIMITED') && l.includes('HOPPER_MASTER_KEY'))).toBe(true);
    const view = await keyView(limited);
    expect(view).toMatchObject({ source: 'missing', fingerprint: fingerprintOf(key).slice(0, 16), revealable: false });
    expect(view.problem).toContain('HOPPER_MASTER_KEY');
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(key));
    const refused = await setSecret(limited, s2, 'another-value-0123456789');
    expect(refused.status).toBe(503);
    expect(refused.body.error).toContain('HOPPER_MASTER_KEY');
    expect(vaultRows(dbPath)).toEqual(before);
    expect((await vault(limited)).problem).toContain('HOPPER_MASTER_KEY');
    // Connecting GitHub asks for no new sign-in: it says the key is missing.
    const connect = await limited.ui<{ error?: string; state?: string }[]>('/ui/api/connected-accounts', { action: 'connect', provider: 'github' }, { token: s2 });
    expect(JSON.stringify(connect.body)).toContain('the master key is missing');

    // Given the key again: everything opens.
    const { a: back } = await boot(dbPath, { HOPPER_MASTER_KEY: key });
    expect(await opened(back, key)).toBe(VALUE);
  });

  it('a wrong key stops the start, saying it does not match this database; nothing in the database changes', async () => {
    const dbPath = freshDb();
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await setSecret(a, session);
    await a.stop();
    t = undefined;
    const settings = instanceSettings(dbPath);
    const rows = vaultRows(dbPath);

    await expect(startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: NEW_KEY } })).rejects.toThrow('the master key does not match this database');
    expect(instanceSettings(dbPath)).toEqual(settings);
    expect(vaultRows(dbPath)).toEqual(rows);
  });

  it('the old token key: read from the old volume\'s file, shown to be saved, and every secret stays readable; once HOPPER_MASTER_KEY is set the old key can go', async () => {
    const dbPath = freshDb();
    // An install from before: its secrets sealed under the token key, no fingerprint recorded.
    const { a, session } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await setSecret(a, session);
    await a.stop();
    t = undefined;
    const db = openDb(databaseUrlFor(dbPath));
    try { db.run("DELETE FROM settings WHERE key = 'masterKeyFingerprint'"); } finally { db.close(); }
    const file = join(mkdtempSync(join(tmpdir(), 'hopper-secrets-')), 'token_key');
    writeFileSync(file, `${KEY}\n`);

    logged = [];
    const { a: moved } = await boot(dbPath, { HOPPER_TOKEN_KEY_FILE: file });
    expect(await opened(moved, KEY)).toBe(VALUE);
    expect(await keyView(moved)).toMatchObject({ source: 'old-token-key', saved: false, revealable: true });
    expect(logged.some((l) => l.includes(`master key: read from the old token key (old-token-key), fingerprint ${fingerprintOf(KEY).slice(0, 16)}`))).toBe(true);
    expect(logged.join('\n')).not.toContain(KEY);
    expect(instanceSettings(dbPath).masterKeyFingerprint).toBe(fingerprintOf(KEY));

    logged = [];
    const { a: set } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY, HOPPER_TOKEN_KEY_FILE: file });
    expect(await opened(set, KEY)).toBe(VALUE);
    expect(await keyView(set)).toMatchObject({ source: 'given', saved: true });
    expect(logged.some((l) => l.includes('can be removed'))).toBe(true);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('hopper master-key status: the source, the fingerprint and whether a previous key is set, as JSON; never a key (issue #685)', async () => {
    const dbPath = freshDb();
    const status = async (a: TestApp) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(['master-key', 'status', '--url', a.url], { env: { HOPPER_DATABASE_URL: databaseUrlFor(dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) });
      return { code, out: out.join(''), err: err.join('') };
    };
    const { a } = await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    const given = await status(a);
    expect(given.code, given.err).toBe(0);
    expect(JSON.parse(given.out)).toEqual({ source: 'given', fingerprint: fingerprintOf(KEY).slice(0, 16), previous: false });

    const { a: rotated } = await boot(dbPath, { HOPPER_MASTER_KEY: NEW_KEY, HOPPER_MASTER_KEY_PREVIOUS: KEY });
    const r = await status(rotated);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ source: 'given', fingerprint: fingerprintOf(NEW_KEY).slice(0, 16), previous: true });
    for (const text of [given.out, given.err, r.out, r.err, logged.join('\n')]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(NEW_KEY);
    }
  });
});
