// Issue #658, through the real composition root and the real database: the hopper keeps its own secrets in the vault's
// system scope. A hopper from before #658 keeps them where each kind was kept: a webhook's signing secret sealed in its
// subscription's row, the GitHub connection's tokens sealed by the token box in its row, a sign-in realm's client secret
// in clear in the `sign-in` record. The first start of this build moves each into the vault — kept, opened again, the old
// copy removed —, one `vault.secret_migrated` each, never a value; the next start changes nothing; and each keeps working
// across the move. Settings → Vault shows them and their audit trail, never a value.
//
// Feature: the hopper's own secrets in the vault's system scope
//   Scenario: a start moves every secret kept before into the vault; GitHub, the webhook and the realm keep working
//   Scenario: a second start changes nothing
//   Scenario: the vault's view shows the system secrets and their audit trail, with no value
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSignInConfig } from '../../src/auth/config.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { openDb } from '../../src/store/db.ts';
import type { VaultView } from '../../src/domain/vault.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { writeConfig, writeWebhooks } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';
import { ENTERED, KEY, signatureOf } from '../support/webhooks.ts';

const ACCESS = 'gho_access0123456789abcdefWXYZ';
const REFRESH = 'ghr_refresh0123456789abcdefQRST';
const CLIENT = 'oidc-client-secret-0123456789-LMNO';
const REALM = { name: 'corp', type: 'oidc', enabled: false, issuer: 'https://idp.example.com', clientId: 'hopper', clientSecret: CLIENT };

let t: TestApp | undefined;
let rx: Receiver | undefined;
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
  await rx?.close();
  rx = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

const run = (url: string, fn: (db: ReturnType<typeof openDb>) => void): void => {
  const db = openDb(url);
  try { fn(db); } finally { db.close(); }
};
const all = (url: string, sql: string): Record<string, unknown>[] => {
  const db = openDb(url);
  try { return db.all(sql); } finally { db.close(); }
};

/** A hopper from before issue #658: each secret where its kind was kept. */
async function before(): Promise<{ dbPath: string; receiver: Receiver }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const receiver = await startReceiver(200);
  rx = receiver;
  writeWebhooks(db.dbPath, [{ name: 'rx', url: receiver.url, events: ['job.finished'] }]);
  writeConfig(db.dbPath, 'sign-in', { realms: [REALM] });
  const owner = ownerSchemaUrlFor(db.dbPath);
  const box = createTokenBox(KEY);
  run(owner, (d) => {
    const id = String(d.get("SELECT id FROM webhooks WHERE name = 'rx'")!.id);
    d.run('UPDATE webhooks SET secret_sealed = ?, secret_changed_at = ? WHERE id = ?', createSealer(KEY).seal(ENTERED, `webhook:${id}/signing-secret`), '2026-10-01T00:00:00.000Z', id);
    d.run('INSERT INTO connected_accounts (provider, body) VALUES (?, ?)', 'github', JSON.stringify({
      provider: 'github', account: 'octo-user', subject: '1', connectedAt: '2026-10-01T00:00:00.000Z', grantedBy: 'device',
      accessToken: box.seal(ACCESS), refreshToken: box.seal(REFRESH), expiresAt: '2099-01-01T00:00:00.000Z',
    }));
  });
  return { dbPath: db.dbPath, receiver };
}

const boot = async (dbPath: string): Promise<TestApp> => {
  t = await startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: KEY } });
  return t;
};
const migrated = (a: TestApp) => a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.secret_migrated');
const vaultRows = (dbPath: string) => [
  ...all(ownerSchemaUrlFor(dbPath), 'SELECT name, sealed FROM vault_secrets ORDER BY name'),
  ...all(databaseUrlFor(dbPath), 'SELECT name, sealed FROM vault_secrets ORDER BY name'),
];

describe('the hopper\'s own secrets move into the vault\'s system scope (issue #658)', () => {
  it('a start moves every secret kept before into the vault; GitHub, the webhook and the realm keep working', async () => {
    const { dbPath, receiver } = await before();
    const a = await boot(dbPath);
    expect(vaultRows(dbPath).map((r) => [r.name, String(r.sealed).startsWith('hs1.')])).toEqual([
      ['system/connected-account.github.access-token', true], ['system/connected-account.github.refresh-token', true],
      [expect.stringMatching(/^system\/webhook\.[\w-]+\.signing-secret$/), true],
      ['system/sign-in.corp.clientSecret', true],
    ]);
    // The old copies are gone.
    expect(all(ownerSchemaUrlFor(dbPath), 'SELECT secret_sealed FROM webhooks')).toEqual([{ secret_sealed: null }]);
    expect(JSON.stringify(all(ownerSchemaUrlFor(dbPath), 'SELECT body FROM connected_accounts'))).not.toMatch(/accessToken|refreshToken/);
    expect(JSON.stringify(all(databaseUrlFor(dbPath), "SELECT value FROM config WHERE name = 'sign-in'"))).not.toContain('clientSecret');
    // One event per secret, the realm's too (the instance's events reach every user's log), and never a value.
    await waitFor(() => migrated(a).length === 4 || undefined, { what: 'four moves recorded' });
    expect(migrated(a).map((e) => (e.data as { from: string }).from).sort()).toEqual(['connected_accounts', 'connected_accounts', 'sign-in', 'webhooks']);
    // Each keeps working: the connection, the realm's secret, and the webhook signs as before.
    expect(await a.user().connectedAccounts.token('github')).toBe(ACCESS);
    expect((await a.user().connectedAccounts.status())[0]).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(loadSignInConfig(a.app.instance.signInConfig.read()).realms[0]).toMatchObject({ name: 'corp', clientSecret: CLIENT });
    expect((await a.api('GET', '/api/realms', undefined, { 'x-hopper-session': await a.login() })).body.realms[0]).toMatchObject({ name: 'corp', secrets: ['clientSecret'] });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    const got = await waitFor(() => receiver.received.find((r) => r.headers['x-hopper-event'] === 'job.finished'));
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(ENTERED, got));
    for (const value of [ACCESS, REFRESH, CLIENT, ENTERED]) {
      expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
      expect(logged.join('\n')).not.toContain(value);
      expect(JSON.stringify(vaultRows(dbPath))).not.toContain(value);
    }
  });

  it('a second start changes nothing', async () => {
    const { dbPath } = await before();
    const first = await boot(dbPath);
    await waitFor(() => migrated(first).length === 4 || undefined, { what: 'four moves recorded' });
    const rows = vaultRows(dbPath);
    await first.stop();
    t = undefined;
    const again = await boot(dbPath);
    expect(vaultRows(dbPath)).toEqual(rows);
    expect(migrated(again)).toHaveLength(4);
    expect(await again.user().connectedAccounts.token('github')).toBe(ACCESS);
  });

  it('the vault\'s view shows the system secrets and their audit trail, with no value', async () => {
    const { dbPath } = await before();
    const a = await boot(dbPath);
    await waitFor(() => migrated(a).length === 4 || undefined, { what: 'four moves recorded' });
    const session = await a.login();
    const view = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body;
    expect(view.secrets).toEqual([]);
    expect(view.system!.secrets.map((s) => [s.name.replace(/webhook\.[\w-]+\./, 'webhook.<id>.'), s.kind, s.scope, s.last4])).toEqual([
      ['connected-account.github.access-token', 'connected-account', 'user', 'WXYZ'],
      ['connected-account.github.refresh-token', 'connected-account', 'user', 'QRST'],
      ['webhook.<id>.signing-secret', 'webhook', 'user', ENTERED.slice(-4)],
      ['sign-in.corp.clientSecret', 'sign-in', 'instance', 'LMNO'],
    ]);
    expect(view.system!.audit.filter((e) => e.type === 'vault.secret_migrated')).toHaveLength(4);
    expect(view.system!.audit.some((e) => e.type === 'vault.secret_read' && e.by === 'hopper')).toBe(true);
    for (const value of [ACCESS, REFRESH, CLIENT, ENTERED]) expect(JSON.stringify(view)).not.toContain(value);
  });
});
