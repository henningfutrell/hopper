// Issue #586, through the real composition root, the real HTTP server and the real vault server: the vault runs in a
// container of its own. The hopper reaches it at HOPPER_VAULT_URL with the preshared key HOPPER_VAULT_KEY; the vault
// keeps its key (here: the token key, which the hopper is not given at all), seals, and keeps its write-only rule. The
// hopper keeps the event log. When the vault cannot be reached, the hopper still works and says why the vault does not.
//
// Feature: the vault in a container of its own
//   Scenario: a secret set in the UI is sealed by the vault container, under a key the hopper does not hold
//     Given a vault container with the token key, and a hopper with none
//     When the admin sets the vault secret DEPLOY_KEY
//     Then the vault lists it, with no value, and the database holds it sealed under the vault's key
//     And the hopper's event log records vault.secret_set, without the value
//   Scenario: a hopper with the wrong preshared key is refused by the vault, and says so
//   Scenario: a vault that is not running: the hopper starts and works, and the vault says it is not reachable
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSealer } from '../../src/secrets/sealer.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { ownerSchemaUrlFor } from '../support/database.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'vault-container-value-0123456789abcdef-never-read-back';

let t: TestApp | undefined;
const stops: (() => Promise<void> | void)[] = [];
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
  for (const s of stops.splice(0).reverse()) await s();
  vi.restoreAllMocks();
});

type View = { secrets: Record<string, unknown>[]; templates: unknown[]; problem?: string };

/** A hopper with no token key of its own, told the vault is at `vaultUrl`; then, unless `noVault`, the vault container. */
async function boot(o: { hopperKey?: string; noVault?: boolean } = {}): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  stops.push(db.cleanup);
  // The vault's port is known only once it listens; a hopper reads HOPPER_VAULT_URL at start. So: a vault on a port
  // first (over a database the hopper has not made yet, it only listens), then the hopper told its URL.
  const vault = o.noVault ? undefined : await startVaultContainer(db.dbPath, { HOPPER_TOKEN_KEY: KEY });
  if (vault) stops.push(() => vault.stop());
  t = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_VAULT_URL: vault?.url ?? 'http://127.0.0.1:9' },
    secrets: { HOPPER_VAULT_KEY: o.hopperKey ?? VAULT_KEY },
  });
  return { a: t, session: await t.login() };
}

const view = async (a: TestApp): Promise<View> => (await a.api('GET', '/api/vault')).body as View;
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<View & { error?: string }>('/ui/api/vault', body, { token: session });

function rows(a: TestApp): Record<string, unknown>[] {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { return db.all('SELECT * FROM vault_secrets ORDER BY seq'); } finally { db.close(); }
}

describe('the vault in a container of its own (issue #586)', () => {
  it('a secret set in the UI is sealed by the vault container, under a key the hopper does not hold', async () => {
    const { a, session } = await boot();
    const r = await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', scope: 'k3s lab', value: VALUE });
    expect(r.status).toBe(200);
    expect(r.body.secrets).toMatchObject([{ name: 'DEPLOY_KEY', scope: 'k3s lab' }]);
    expect(JSON.stringify(r.body)).not.toContain(VALUE);
    expect((await view(a)).problem).toBeUndefined();

    const [row] = rows(a);
    expect(String(row!.sealed)).not.toContain(VALUE);
    expect(String(row!.sealed).split('.')[1]).toBe(createSealer(KEY).keyId);
    expect(createSealer(KEY).open(String(row!.sealed), `vault:${String(row!.id)}/value`)).toBe(VALUE);

    const set = a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.secret_set');
    expect(set).toMatchObject([{ data: { name: 'DEPLOY_KEY', replaced: false } }]);
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(VALUE);
    expect(logged.join('\n')).not.toContain(VALUE);

    // The rest of the vault's edits go through the container too.
    const saved = await edit(a, session, { action: 'save-template', name: 'kube', image: 'localhost/box:1', secrets: ['DEPLOY_KEY'] });
    expect(saved.body.error).toBeUndefined();
    expect(saved.status).toBe(200);
    expect((await edit(a, session, { action: 'approve-template', name: 'kube' })).body.templates).toMatchObject([{ name: 'kube', gives: ['DEPLOY_KEY'] }]);
    expect((await edit(a, session, { action: 'remove', name: 'NOPE' })).status).toBe(404);
  });

  it('a hopper with the wrong preshared key is refused by the vault, and says so', async () => {
    const { a, session } = await boot({ hopperKey: 'not-the-vault-key-0123456789abcdef' });
    expect((await view(a)).problem).toMatch(/vault.*refused/);
    const r = await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    expect(r.status).toBe(503);
    expect(rows(a)).toHaveLength(0);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it('a vault that is not running: the hopper starts and works, and the vault says it is not reachable', async () => {
    const { a, session } = await boot({ noVault: true });
    expect((await a.api('GET', '/api/health')).status).toBe(200);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    expect((await view(a)).problem).toMatch(/not reachable/);
    const r = await edit(a, session, { action: 'set', name: 'DEPLOY_KEY', value: VALUE });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not reachable/);
    expect(logged.join('\n')).not.toContain(VALUE);
  });
});
