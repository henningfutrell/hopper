// Issue #658 requirement 6, through the real composition root, the real HTTP server and a real HashiCorp Vault: a
// webhook's signing secret, one of the hopper's own secrets a person gives, is kept in a vault backend when the owner
// turns that on. The hopper reads it at start, when it is set and at each refresh, and holds it in its process memory
// only. A start that cannot read it names the secret and the backend, and signs with no stale or local copy. A rotation
// is refused, pointing at the backend.
//
// Feature: a system secret kept in a vault backend
//   Scenario: a webhook's signing secret kept in HashiCorp Vault signs each delivery
//     Given a vault backend my-vault (hashicorp-vault) and a value at hooks/rx#secret in it
//     When the owner keeps the webhook's signing secret in my-vault at hooks/rx#secret on Vault
//     Then a delivery is signed with the value Vault holds, and the hopper's database holds no value for it
//     And the vault's view shows where it is kept, and no value
//   Scenario: a rotation is refused, pointing at the backend
//   Scenario: a start that cannot read the backend names the secret and the backend, and signs with nothing
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultView } from '../../src/domain/vault.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { writeWebhooks } from '../support/files.ts';
import { startTestVault, type TestVault } from '../support/hashicorp-vault.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { edit, KEY, nextDelivery, rowOf, secretRowOf, signatureOf } from '../support/webhooks.ts';

const VALUE = 'webhook-secret-kept-in-vault-0123456789abcdef';
let vault: TestVault;
let t: TestApp | undefined;
let rx: Receiver | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeAll(async () => { vault = await startTestVault(); }, 120_000);
afterAll(async () => { await vault?.stop(); });
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

const BACKEND = (address: string) => ({ name: 'my-vault', plugin: 'hashicorp-vault', options: { address, tokenEnv: 'VAULT_TOKEN' } });

/** A hopper with the vault backend my-vault and the webhook rx; `dbPath`: the same store, started again (its plugins config kept). */
async function boot(vaultToken: string, dbPath?: string): Promise<{ a: TestApp; token: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
    rx = await startReceiver(200);
    writeWebhooks(path, [{ name: 'rx', url: rx.url, events: ['job.finished'] }]);
  }
  t = await startTestApp({
    dbPath: path, secrets: { HOPPER_MASTER_KEY: KEY, VAULT_TOKEN: vaultToken }, seams: { authorizationServer: createFakeAuthorizationServer() },
    ...(dbPath ? {} : { plugins: { executors: [{ name: 'test', plugin: 'test' }], vaultBackends: [BACKEND(vault.addr)] } }),
  });
  return { a: t, token: await t.login() };
}

describe('a system secret kept in a vault backend (issue #658, requirement 6)', () => {
  it('signs each delivery with the value the backend holds; a rotation is refused; a start that cannot read it says so', async () => {
    await vault.write('hooks/rx', { secret: VALUE });
    const { a, token } = await boot(vault.token);
    const name = `webhook.${String(rowOf(a, 'rx').id)}.signing-secret`;

    const set = await a.ui('/ui/api/vault', { action: 'system-in-backend', name, backend: 'my-vault', reference: 'hooks/rx#secret' }, { token });
    expect(set.status).toBe(200);
    const view = (await a.api('GET', '/api/vault')).body as VaultView;
    expect(view.system!.secrets.find((s) => s.name === name)).toMatchObject({ backend: { name: 'my-vault', reference: 'hooks/rx#secret' }, last4: VALUE.slice(-4) });
    expect(secretRowOf(a, 'rx')!.sealed).toBe('null');

    const got = await nextDelivery(a, rx!);
    expect(got.headers['x-hopper-signature']).toBe(signatureOf(VALUE, got));

    const rotate = await edit(a, token, { action: 'rotate', name: 'rx' });
    expect(rotate.status).toBe(409);
    expect(JSON.stringify(rotate.body)).toMatch(/kept in vault backend my-vault at hooks\/rx#secret: rotate it there/);

    for (const where of [JSON.stringify(a.user().store.events.since(0, 100_000)), JSON.stringify(view), logged.join('\n')]) expect(where).not.toContain(VALUE);

    // The backend's token goes wrong: the next start cannot read the secret.
    await a.stop();
    const again = await boot('not-a-token', a.dbPath);
    expect(logged.join('\n')).toMatch(new RegExp(`start check: system secret ${name.replace(/\./g, '\\.')} cannot be read from vault backend my-vault`));
    const subs = (await again.a.api('GET', '/api/webhooks')).body.subscriptions as { name: string; secretProblem?: string }[];
    expect(subs.find((s) => s.name === 'rx')!.secretProblem).toMatch(/my-vault/);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it('is refused for a secret the hopper writes itself', async () => {
    const { a, token } = await boot(vault.token);
    const r = await a.ui('/ui/api/vault', { action: 'system-in-backend', name: 'connected-account.github.access-token', backend: 'my-vault', reference: 'gh#token' }, { token });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/stays in the hopper/);
  });
});
