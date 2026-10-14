// Issue #658: the sign-in realms' secrets in the instance's vault. Everything reads and writes the sign-in config as
// before; the `sign-in` record never holds a secret. A write keeps each secret given in the vault, removes each one left
// out, and stores the record without them; a read gives each realm its secrets back. A secret replaced alone changes the
// version, so the sign-in service applies it and an edit made against the older version is refused.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealedSignIn, withHeldSecrets } from '../../src/auth/sealed-secrets.ts';
import type { SignInConfigRepository, StoredSignIn } from '../../src/domain/ports.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createSystemSecrets } from '../../src/vault/system.ts';
import { memoryAccountStore } from '../support/system-secrets.ts';

const OIDC = { name: 'corp', type: 'oidc', enabled: true, issuer: 'https://idp.example.com', clientId: 'hopper' };
const LDAP = { name: 'dir', type: 'ldap', enabled: true, url: 'ldaps://ldap.example.com', bindDn: 'cn=hopper' };

function overlay(shared?: ReturnType<typeof memoryAccountStore>, key: string | null = randomBytes(32).toString('hex'), start?: StoredSignIn) {
  let record: StoredSignIn = start ?? { version: 1, realms: [] };
  const raw: SignInConfigRepository = {
    read: () => structuredClone(record),
    version: () => createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    write(next, version) { if (raw.version() !== version) return false; record = structuredClone(next); return true; },
  };
  const { store, events, secrets } = shared ?? memoryAccountStore();
  let tick = Date.parse('2026-10-10T12:00:00Z');
  const system = createSystemSecrets({
    store, keys: key ? { sealer: createSealer(key) } : { problem: 'the master key is missing' }, userId: 'instance', scope: 'instance',
    clock: { now: () => new Date(tick += 1000) }, idGen: () => randomBytes(8).toString('hex'), logger: { warn: () => undefined },
  });
  return { config: sealedSignIn({ raw, system, tx: (fn) => fn(), logger: { warn: () => undefined } }), record: () => record, events, secrets };
}

describe('the sign-in realms\' secrets in the instance\'s vault (issue #658)', () => {
  it('a write keeps the secrets in the vault and the record without them; a read gives them back', () => {
    const o = overlay();
    expect(o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-1234' }, { ...LDAP, bindPassword: 'bp-5678' }] }, o.config.version())).toBe(true);
    expect(JSON.stringify(o.record())).not.toMatch(/cs-1234|bp-5678|clientSecret|bindPassword/);
    expect([...o.secrets.keys()].sort()).toEqual(['system/sign-in.corp.clientSecret', 'system/sign-in.dir.bindPassword']);
    expect(o.config.read().realms).toEqual([{ ...OIDC, clientSecret: 'cs-1234' }, { ...LDAP, bindPassword: 'bp-5678' }]);
    expect(JSON.stringify(o.events)).not.toMatch(/cs-1234|bp-5678/);
  });

  it('a secret replaced alone changes the version; an edit against the older one is refused', () => {
    const o = overlay();
    o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-1234' }] }, o.config.version());
    const v1 = o.config.version();
    // The same secret again writes nothing new.
    expect(o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-1234' }] }, v1)).toBe(true);
    expect(o.events.filter((e) => e.type === 'vault.secret_set')).toHaveLength(1);
    expect(o.config.version()).toBe(v1);
    expect(o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-9999' }] }, v1)).toBe(true);
    expect(o.config.version()).not.toBe(v1);
    expect(o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-0000' }] }, v1)).toBe(false);
    expect(o.config.read().realms[0]).toMatchObject({ clientSecret: 'cs-9999' });
  });

  it('a secret left out, or its realm removed, is removed from the vault', () => {
    const o = overlay();
    o.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-1234' }, { ...LDAP, bindPassword: 'bp-5678' }] }, o.config.version());
    o.config.write({ version: 1, realms: [{ ...OIDC }] }, o.config.version());
    expect([...o.secrets.keys()]).toEqual([]);
    expect(o.events.filter((e) => e.type === 'vault.secret_removed').map((e) => (e.data as { name: string }).name).sort()).toEqual(['system/sign-in.corp.clientSecret', 'system/sign-in.dir.bindPassword']);
  });

  it('limited (no master key, issue #659): a realm whose secret cannot be opened is read as off; a write keeps the record\'s switch and what is given', () => {
    const shared = memoryAccountStore();
    const keyed = overlay(shared);
    keyed.config.write({ version: 1, realms: [{ ...OIDC, clientSecret: 'cs-1234' }] }, keyed.config.version());
    const limited = overlay(shared, null, keyed.record());
    expect(limited.config.read().realms[0]).toEqual({ ...OIDC, enabled: false });
    expect(limited.config.write({ version: 1, realms: [{ ...OIDC, enabled: false, label: 'Corp' }, { ...LDAP, bindPassword: 'bp-5678' }] }, limited.config.version())).toBe(true);
    expect(limited.record().realms).toEqual([{ ...OIDC, label: 'Corp' }, { ...LDAP, bindPassword: 'bp-5678' }]);
  });

  it('the operator CLI checks a record without its secrets as having the ones the vault holds', () => {
    const record = { version: 1, realms: [OIDC, LDAP] };
    expect(withHeldSecrets(record, ['system/sign-in.corp.clientSecret'])).toEqual({ version: 1, realms: [{ ...OIDC, clientSecret: '(kept in the vault)' }, LDAP] });
  });
});
