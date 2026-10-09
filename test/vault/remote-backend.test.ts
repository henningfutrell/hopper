// Issue #586 with issue #585: with the vault in a container of its own, a secret kept in a vault backend stays in the
// hopper — it runs the backends; the vault container never sees one. Its set and its delivery are the hopper's vault
// service's, so they work while the vault container cannot be reached; a value set goes to the container, and is
// unavailable then.
//
// Feature: a secret kept in a vault backend, with the vault in its own container
//   Scenario: setting it needs no vault container; setting a value does
//   Scenario: its delivery is decided in the hopper, not sent to the vault container
import { describe, expect, it } from 'vitest';
import type { ConfiguredBackend, VaultSecret } from '../../src/domain/vault.ts';
import { runtimeSecrets } from '../../src/secrets/runtime.ts';
import { remoteVault } from '../../src/vault/remote.ts';
import { createVaultService } from '../../src/vault/service.ts';

function memoryStore() {
  const rows = new Map<string, { secret: VaultSecret; sealed: string | null }>();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  return {
    rows, events,
    store: {
      vault: {
        list: () => [...rows.values()].map((r) => r.secret),
        get: (name: string) => [...rows.values()].find((r) => r.secret.name === name)?.secret,
        add: (s: VaultSecret, sealed: string | null) => { rows.set(s.id, { secret: s, sealed }); return true; },
        replace: (s: VaultSecret, sealed: string | null) => { rows.set(s.id, { secret: s, sealed }); return true; },
        sealed: (id: string) => rows.get(id)?.sealed ?? undefined,
        remove: () => false, templates: () => [], template: () => undefined,
      },
      events: { append: (e: { type: string; data: Record<string, unknown> }) => { events.push(e); return e; } },
      tx: <T>(fn: () => T): T => fn(),
      jobs: { get: () => undefined },
      settings: { getBlastRadius: () => undefined },
    },
  };
}

const backend: ConfiguredBackend = {
  name: 'hv', plugin: 'hashicorp-vault',
  backend: { name: 'hv', check: () => undefined, read: async () => 'from-the-backend' },
};

function vaultOver(m: ReturnType<typeof memoryStore>) {
  const local = createVaultService({
    store: m.store as never, keys: { problem: 'the vault\'s key is in its container' }, clock: { now: () => new Date('2026-10-09T00:00:00Z') },
    idGen: () => 'id-1', logger: { warn: () => {} }, targets: () => [], holds: () => true, backends: () => [backend],
  });
  // A vault container that is not running: the port is closed.
  return remoteVault({ url: 'http://127.0.0.1:9', secret: runtimeSecrets({ HOPPER_VAULT_KEY: 'k' }), user: 'admin', store: m.store as never, local, targets: () => [], holds: () => true });
}

describe('a secret kept in a vault backend, with the vault in its own container (issues #585, #586)', () => {
  it('setting it needs no vault container; setting a value does', async () => {
    const m = memoryStore();
    const vault = vaultOver(m);
    expect(await vault.set({ name: 'DB_PASSWORD', backend: 'hv', reference: 'apps/db#password' }, 'Ada')).toEqual({ ok: true });
    expect(m.rows.get('id-1')).toMatchObject({ secret: { name: 'DB_PASSWORD', backend: { name: 'hv', reference: 'apps/db#password' } }, sealed: null });
    expect(await vault.set({ name: 'KUBE_TOKEN', value: 'v' }, 'Ada')).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringMatching(/not reachable/) });
  });

  it('its delivery is decided in the hopper, not sent to the vault container', async () => {
    const m = memoryStore();
    const vault = vaultOver(m);
    await vault.set({ name: 'DB_PASSWORD', backend: 'hv', reference: 'apps/db#password' }, 'Ada');
    // The hopper's own checks answer (no joined machine holds this key), not "the vault is not reachable".
    expect(await vault.deliver({ name: 'DB_PASSWORD', token: 'x' }, 'no-such-key')).toEqual({ refused: 'no joined machine holds that key' });
    // A secret the vault container keeps goes there: not reachable, said so and recorded.
    expect(await vault.deliver({ name: 'KUBE_TOKEN', token: 'x' }, 'no-such-key')).toMatchObject({ refused: expect.stringMatching(/not reachable/) });
    expect(m.events.filter((e) => e.type === 'vault.refused')).toHaveLength(2);
  });
});
