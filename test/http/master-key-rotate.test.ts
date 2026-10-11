// Issue #659 requirement 6: the master key status's rotation. It refuses when there is no key (limited) and when the
// composition root says this hopper cannot rotate (the vault in a container of its own); else it hands the current keys
// and a new key to the rotation, and answers the new key this once.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMasterKeyStatus } from '../../src/http/master-key.ts';
import { fingerprintOf, type MasterKey } from '../../src/secrets/master-key.ts';

const KEY = randomBytes(32).toString('hex');
const given: MasterKey = { source: 'given', key: KEY, previous: [], fingerprint: fingerprintOf(KEY), notes: [] };
const settings = () => {
  let saved: string | undefined;
  return { masterKeySaved: () => saved, setMasterKeySaved: (fp: string) => { saved = fp; } };
};

describe('MasterKeyStatus.rotate', () => {
  it('a limited hopper cannot rotate: 409 naming the missing key; the rotation is not asked', () => {
    let asked = false;
    const status = createMasterKeyStatus({ source: 'missing', problem: 'the master key is missing: give it as HOPPER_MASTER_KEY' }, settings(), () => { asked = true; return { resealed: 0, unreadable: 0 }; });
    expect(() => status.rotate('admin')).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('HOPPER_MASTER_KEY') }));
    expect(asked).toBe(false);
  });

  it('the vault in a container of its own: 409 with the reason; the key stays', () => {
    const status = createMasterKeyStatus(given, settings(), { why: 'the vault runs in a container of its own (HOPPER_VAULT_URL)' });
    expect(() => status.rotate('admin')).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('HOPPER_VAULT_URL') }));
    expect(status.view()).toMatchObject({ source: 'given', fingerprint: fingerprintOf(KEY).slice(0, 16) });
  });

  it('hands the current keys, a new key and who pressed it to the rotation; answers the new key once, to be saved', () => {
    const asked: unknown[] = [];
    const status = createMasterKeyStatus({ ...given, previous: [randomBytes(32).toString('hex')] }, settings(), (r) => { asked.push(r); return { resealed: 3, unreadable: 1 }; });
    const r = status.rotate('admin');
    expect(asked).toEqual([{ from: { key: KEY, previous: [expect.any(String)] }, to: r.key, by: 'admin' }]);
    expect(r).toEqual({ source: 'rotated', fingerprint: fingerprintOf(r.key).slice(0, 16), previous: false, saved: false, revealable: false, key: r.key, resealed: 3, unreadable: 1 });
    expect(status.reveal()).toBeUndefined();
    expect(status.saved()).toMatchObject({ source: 'rotated', saved: true });
  });
});
