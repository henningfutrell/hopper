// Issue #585, through the real composition root, the real HTTP server, a real joined box and a real HashiCorp Vault: a
// vault secret can be kept in a vault backend instead of the hopper's database. The hopper's vault stays the one front
// door: the template's approval, the job's token and the delivery sealed to one request are the same; only where the
// value is kept changes. The hopper reads it from the backend at the moment of use and keeps no copy (design.md "Vault
// backends").
//
// Feature: a vault secret kept in a vault backend
//   Scenario: a secret kept in HashiCorp Vault is delivered to the box just in time
//     Given a vault backend my-vault (hashicorp-vault) and the value at apps/db#password in it
//     And the vault secret DB_PASS kept in my-vault at apps/db#password, in the approved scope of the box's template
//     When a job on the box runs `$HOPPER_SECRET get DB_PASS`
//     Then it gets the value Vault holds now, and the hopper's database holds no value for it
//     When the value in Vault changes
//     Then the next ask gets the new value
//   Scenario: a vault backend is optional
//     Given a hopper with no vault backend
//     Then a secret kept in the hopper is delivered, and a secret kept in a backend that is gone is refused, saying why
//   Scenario: a secret cannot point at a backend the hopper does not have, or at a reference the backend cannot read
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startTestVault, type TestVault } from '../support/hashicorp-vault.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'db-password-0123456789abcdef-kept-in-vault';
const NEXT = 'db-password-rotated-fedcba9876543210';
const LOCAL = 'kept-in-the-hopper-0123456789';

let vault: TestVault;
let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
let logged: string[] = [];
const saved = { ...process.env };

beforeAll(async () => { vault = await startTestVault(); }, 120_000);
afterAll(async () => { await vault?.stop(); });

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const BACKEND = (address: string) => ({ name: 'my-vault', plugin: 'hashicorp-vault', options: { address, tokenEnv: 'VAULT_TOKEN' } });

async function boot(vaultBackends: unknown[]): Promise<{ a: TestApp; session: string; edit: (b: Record<string, unknown>) => ReturnType<TestApp['ui']> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY, VAULT_TOKEN: vault.token },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] }, vaultBackends },
  });
  const session = await t.login();
  const a = t;
  return { a, session, edit: (body) => a.ui('/ui/api/vault', body, { token: session }) };
}

describe('a vault secret kept in a vault backend', () => {
  it('is read from HashiCorp Vault at the moment of use and delivered to the box; the hopper keeps no copy', async () => {
    await vault.write('apps/db', { password: VALUE });
    const { a, session, edit } = await boot([BACKEND(vault.addr)]);
    expect((await edit({ action: 'set-in-backend', name: 'DB_PASS', backend: 'my-vault', reference: 'apps/db#password' })).status).toBe(200);
    expect((await edit({ action: 'save-template', name: 'db', image: 'localhost/box-db:1', secrets: ['DB_PASS'] })).status).toBe(200);
    await edit({ action: 'approve-template', name: 'db' });

    const view = (await a.api('GET', '/api/vault')).body as { secrets: { name: string; backend?: unknown }[]; backends: { name: string; plugin: string | null }[] };
    expect(view.secrets.find((s) => s.name === 'DB_PASS')!.backend).toEqual({ name: 'my-vault', reference: 'apps/db#password' });
    expect(view.backends).toEqual([expect.objectContaining({ name: 'my-vault', plugin: 'hashicorp-vault' })]);
    const stored = a.user().store.vault.get('DB_PASS')!;
    expect(a.user().store.vault.sealed(stored.id)).toBeUndefined();

    const dir = await box.join(a, session, 'hopper-sandbox-db', 'db');
    const token = box.tokenFileOf(a, await runningJob(a, 'hopper-sandbox-db'));
    expect(await helper(dir, ['get', 'DB_PASS'], token)).toMatchObject({ code: 0, stdout: VALUE });

    await vault.write('apps/db', { password: NEXT });
    expect(await helper(dir, ['get', 'DB_PASS'], token)).toMatchObject({ code: 0, stdout: NEXT });

    expect((await a.events()).filter((e) => e.type === 'vault.delivered')[0]).toMatchObject({ data: { name: 'DB_PASS', template: 'db', backend: 'my-vault' } });
    for (const v of [VALUE, NEXT]) {
      expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(v);
      expect(logged.join('\n')).not.toContain(v);
    }
  });

  it('is optional: with no backend the hopper starts, its own secrets are delivered, and one kept in a backend that is gone is refused', async () => {
    await vault.write('apps/db', { password: VALUE });
    const first = await boot([BACKEND(vault.addr)]);
    await first.edit({ action: 'set-in-backend', name: 'DB_PASS', backend: 'my-vault', reference: 'apps/db#password' });
    await first.edit({ action: 'set', name: 'LOCAL_KEY', value: LOCAL });
    await first.edit({ action: 'save-template', name: 'db', image: 'localhost/box-db:1', secrets: ['DB_PASS', 'LOCAL_KEY'] });
    await first.edit({ action: 'approve-template', name: 'db' });
    // The backend leaves the plugins config: a person removes it in Settings → Plugins.
    const { a, session } = first;
    const version = (await a.api('GET', '/api/plugins')).body.config.version as string;
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'vault-backend', name: 'my-vault', version }, { token: session })).status).toBe(200);

    expect((await a.api('GET', '/api/vault')).body.backends).toEqual([]);
    const dir = await box.join(a, session, 'hopper-sandbox-db', 'db');
    const token = box.tokenFileOf(a, await runningJob(a, 'hopper-sandbox-db'));
    expect(await helper(dir, ['get', 'LOCAL_KEY'], token)).toMatchObject({ code: 0, stdout: LOCAL });
    const gone = await helper(dir, ['get', 'DB_PASS'], token);
    expect(gone.code).not.toBe(0);
    expect(gone.stderr).toMatch(/no vault backend my-vault/);
    expect(gone.stdout).toBe('');
  });

  it('a backend that cannot be read refuses the ask, saying why, and never answers a value', async () => {
    const { a, session, edit } = await boot([BACKEND(vault.addr)]);
    await edit({ action: 'set-in-backend', name: 'MISSING', backend: 'my-vault', reference: 'apps/nothing-here#password' });
    await edit({ action: 'save-template', name: 'db', image: 'localhost/box-db:1', secrets: ['MISSING'] });
    await edit({ action: 'approve-template', name: 'db' });
    const dir = await box.join(a, session, 'hopper-sandbox-db', 'db');
    const r = await helper(dir, ['get', 'MISSING'], box.tokenFileOf(a, await runningJob(a, 'hopper-sandbox-db')));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/my-vault cannot read MISSING/);
    expect((await a.events()).find((e) => e.type === 'vault.refused')).toMatchObject({ data: { name: 'MISSING', backend: 'my-vault' } });
  });

  it('a secret cannot point at a backend the hopper does not have, or at a reference the backend cannot read', async () => {
    const { edit } = await boot([BACKEND(vault.addr)]);
    const none = await edit({ action: 'set-in-backend', name: 'X', backend: 'other', reference: 'apps/db#password' });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toMatch(/no vault backend other/);
    const bad = await edit({ action: 'set-in-backend', name: 'X', backend: 'my-vault', reference: 'apps/db' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/path#key/);
    const both = await edit({ action: 'set', name: 'X', backend: 'my-vault', reference: 'apps/db#password', value: 'v' });
    expect(both.status).toBe(400);
  });
});
