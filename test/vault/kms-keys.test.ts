// Issue #586: the KMS is an optional key provider for the vault. When one is named, the vault's key is a data key the
// KMS made and wrapped (envelope encryption): the wrapped data key is kept in the user's store, opened by the KMS at
// start, and every vault secret is sealed under it. A secret sealed under the master key before is sealed again under the
// data key. When the KMS gives no data key, the vault says why and stores nothing (fail closed). No KMS: the master key.
//
// Feature: the KMS as the vault's key provider
//   Scenario: the first start wraps a new data key and keeps only its wrapped form
//   Scenario: a later start opens the kept data key: what was sealed before still opens
//   Scenario: a secret sealed under the master key is sealed again under the data key
//   Scenario: a KMS that gives no data key: the vault says why, and nothing is stored
//   Scenario: no KMS: the local key provider, under the master key
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSealer } from '../../src/secrets/sealer.ts';
import { runtimeSecrets } from '../../src/secrets/runtime.ts';
import type { KeyService } from '../../src/vault/kms.ts';
import { vaultKeys } from '../../src/vault/keys.ts';
import { createVaultService, vaultContext } from '../../src/vault/service.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';

const TOKEN_KEY = randomBytes(32).toString('hex');
const secret = runtimeSecrets({ HOPPER_MASTER_KEY: TOKEN_KEY });

/** A KMS that wraps with a key of its own: what it wrapped, only it opens. `down`: it answers nothing. */
function fakeKms(o: { down?: boolean } = {}) {
  const master = randomBytes(32);
  const made: Buffer[] = [];
  const wrap = (plain: Buffer): string => Buffer.concat([Buffer.from('wrapped:'), Buffer.from(plain.map((b, i) => b ^ master[i]!))]).toString('base64');
  const kms: KeyService & { made: Buffer[] } = {
    url: 'http://kms:8080',
    made,
    async newDataKey() {
      if (o.down) throw new Error('connect ECONNREFUSED');
      const plain = randomBytes(32);
      made.push(Buffer.from(plain));
      return { plain, wrapped: wrap(plain) };
    },
    async unwrap(wrapped) {
      if (o.down) throw new Error('connect ECONNREFUSED');
      const body = Buffer.from(wrapped, 'base64').subarray('wrapped:'.length);
      return Buffer.from(body.map((b, i) => b ^ master[i]!));
    },
  };
  return kms;
}

function memoryStore() {
  const rows = new Map<string, { secret: VaultSecret; sealed: string }>();
  let dataKey: string | undefined;
  return {
    rows,
    dataKey: () => dataKey,
    store: {
      vault: {
        list: () => [...rows.values()].map((r) => r.secret),
        get: (name: string) => [...rows.values()].find((r) => r.secret.name === name)?.secret,
        add: (s: VaultSecret, sealed: string) => { rows.set(s.id, { secret: s, sealed }); return true; },
        replace: (s: VaultSecret, sealed: string) => { rows.set(s.id, { secret: s, sealed }); return true; },
        sealed: (id: string) => rows.get(id)?.sealed,
        remove: () => false,
        templates: () => [], template: () => undefined,
        dataKey: () => dataKey,
        keepDataKey: (wrapped: string) => { if (dataKey !== undefined) return false; dataKey = wrapped; return true; },
      },
      events: { append: (e: unknown) => e },
      tx: <T>(fn: () => T): T => fn(),
      jobs: { get: () => undefined },
    },
  };
}

const vaultOver = (m: ReturnType<typeof memoryStore>, keys: Awaited<ReturnType<typeof vaultKeys>>, id = 'id-1') =>
  createVaultService({ store: m.store as never, keys, clock: { now: () => new Date('2026-10-09T00:00:00Z') }, idGen: () => id, logger: { warn: () => {} } });

describe('the KMS as the vault\'s key provider (issue #586)', () => {
  it('the first start wraps a new data key and keeps only its wrapped form; the vault seals under the data key', async () => {
    const m = memoryStore();
    const kms = fakeKms();
    const keys = await vaultKeys({ secret, kms, store: m.store.vault });
    expect(keys.problem).toBeUndefined();
    expect(kms.made).toHaveLength(1);
    const dataKey = kms.made[0]!.toString('hex');
    expect(keys.sealer!.keyId).toBe(createSealer(dataKey).keyId);
    expect(m.dataKey()).toBeDefined();
    expect(m.dataKey()).not.toContain(dataKey);
    expect(Buffer.from(m.dataKey()!, 'base64').includes(kms.made[0]!)).toBe(false);

    expect(vaultOver(m, keys).set({ name: 'KUBE_TOKEN', value: 'v-123' }, 'Ada')).toEqual({ ok: true });
    const sealed = m.rows.get('id-1')!.sealed;
    expect(sealed.split('.')[1]).toBe(createSealer(dataKey).keyId);
    expect(() => createSealer(TOKEN_KEY).open(sealed, vaultContext('id-1'))).toThrow();
    expect(createSealer(dataKey).open(sealed, vaultContext('id-1'))).toBe('v-123');
  });

  it('a later start opens the kept data key: no new key is made, and what was sealed before opens', async () => {
    const m = memoryStore();
    const kms = fakeKms();
    const first = await vaultKeys({ secret, kms, store: m.store.vault });
    vaultOver(m, first).set({ name: 'KUBE_TOKEN', value: 'v-123' }, 'Ada');
    const again = await vaultKeys({ secret, kms, store: m.store.vault });
    expect(kms.made).toHaveLength(1);
    expect(again.sealer!.keyId).toBe(first.sealer!.keyId);
    expect(again.sealer!.open(m.rows.get('id-1')!.sealed, vaultContext('id-1'))).toBe('v-123');
  });

  it('a secret sealed under the master key before the KMS is sealed again under the data key', async () => {
    const m = memoryStore();
    vaultOver(m, { sealer: createSealer(TOKEN_KEY) }).set({ name: 'KUBE_TOKEN', value: 'v-old' }, 'Ada');
    const keys = await vaultKeys({ secret, kms: fakeKms(), store: m.store.vault });
    expect(keys.sealer!.current(m.rows.get('id-1')!.sealed)).toBe(false);
    expect(vaultOver(m, keys).resealAll()).toBe(1);
    const sealed = m.rows.get('id-1')!.sealed;
    expect(keys.sealer!.current(sealed)).toBe(true);
    expect(keys.sealer!.open(sealed, vaultContext('id-1'))).toBe('v-old');
  });

  it('a KMS that gives no data key: the vault says why, names the KMS, and stores nothing', async () => {
    const m = memoryStore();
    const keys = await vaultKeys({ secret, kms: fakeKms({ down: true }), store: m.store.vault });
    expect(keys.sealer).toBeUndefined();
    expect(keys.problem).toContain('http://kms:8080');
    expect(keys.problem).toContain('ECONNREFUSED');
    expect(m.dataKey()).toBeUndefined();
    expect(vaultOver(m, keys).set({ name: 'KUBE_TOKEN', value: 'v' }, 'Ada')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(m.rows.size).toBe(0);
  });

  it('no KMS: the local key provider, under the master key', async () => {
    const m = memoryStore();
    const keys = await vaultKeys({ secret, store: m.store.vault });
    expect(keys.sealer!.keyId).toBe(createSealer(TOKEN_KEY).keyId);
    expect(m.dataKey()).toBeUndefined();
    expect((await vaultKeys({ secret: runtimeSecrets({}), store: m.store.vault })).problem).toContain('HOPPER_MASTER_KEY');
  });
});
