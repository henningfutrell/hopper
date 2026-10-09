// Issue #558, owner constraint: the vault reaches its key through one small seam, the key provider (`Sealer`), whose
// default is local — the runtime's HOPPER_TOKEN_KEY — so a key service could stand behind it later without a rewrite.
// The vault works with any key provider: here a fake one that only marks what it sealed.
import { describe, expect, it } from 'vitest';
import type { Sealer } from '../../src/secrets/sealer.ts';
import { createVaultService } from '../../src/vault/service.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';

function memoryStore() {
  const rows = new Map<string, { secret: VaultSecret; sealed: string }>();
  const events: unknown[] = [];
  return {
    rows, events,
    store: {
      vault: {
        list: () => [...rows.values()].map((r) => r.secret),
        get: (name: string) => [...rows.values()].find((r) => r.secret.name === name)?.secret,
        add: (secret: VaultSecret, sealed: string) => { rows.set(secret.id, { secret, sealed }); return true; },
        replace: (secret: VaultSecret, sealed: string) => { rows.set(secret.id, { secret, sealed }); return true; },
        sealed: (id: string) => rows.get(id)?.sealed,
        remove: (name: string) => { const r = [...rows.values()].find((x) => x.secret.name === name); return r ? rows.delete(r.secret.id) : false; },
      },
      events: { append: (e: unknown) => { events.push(e); return e; } },
      tx: <T>(fn: () => T): T => fn(),
    },
  };
}

const fake: Sealer = {
  keyId: 'fake',
  seal: (value, context) => `fake:${context}:${Buffer.from(value).toString('base64')}`,
  open: (sealed, context) => Buffer.from(sealed.slice(`fake:${context}:`.length), 'base64').toString(),
  current: (sealed) => sealed.startsWith('fake:'),
};

describe('the vault behind its key provider', () => {
  it('seals with whatever key provider it is given, bound to the secret\'s place, and never keeps the value in clear', () => {
    const m = memoryStore();
    const vault = createVaultService({ store: m.store as never, keys: { sealer: fake }, clock: { now: () => new Date('2026-10-09T00:00:00Z') }, idGen: () => 'id-1', logger: { warn: () => {} } });
    expect(vault.set({ name: 'KUBE_TOKEN', value: 'v-123' }, 'Ada')).toEqual({ ok: true });
    const row = m.rows.get('id-1')!;
    expect(row.sealed).toBe(`fake:vault:id-1/value:${Buffer.from('v-123').toString('base64')}`);
    expect(JSON.stringify(row.secret)).not.toContain('v-123');
    expect(JSON.stringify(m.events)).not.toContain('v-123');
  });

  it('no key provider: nothing is stored, and why is said', () => {
    const m = memoryStore();
    const vault = createVaultService({ store: m.store as never, keys: { problem: 'no key' }, clock: { now: () => new Date() }, idGen: () => 'id-1', logger: { warn: () => {} } });
    expect(vault.set({ name: 'KUBE_TOKEN', value: 'v' }, 'Ada')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(m.rows.size).toBe(0);
  });
});
