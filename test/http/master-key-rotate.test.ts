// Issue #659 requirement 6: the master key status's rotation. It refuses when the composition root says this hopper
// cannot rotate (the vault in a container of its own), and a key the host sealed unless the caller seals the new one in
// the same step (issue #1296); else it hands the current keys and a new key to the rotation, and answers the new key this once.
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
  it('a key the host sealed (issue #1296): 409 saying to rotate on the host, the rotation not asked; with hostSeals it rotates', () => {
    let asked = 0;
    const status = createMasterKeyStatus(given, settings(), () => { asked += 1; return { resealed: 0, unreadable: 0 }; }, 'systemd-creds');
    expect(status.view()).toMatchObject({ source: 'given', sealed: 'systemd-creds' });
    expect(() => status.rotate('admin')).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('bash master-key.sh rotate') }));
    expect(asked).toBe(0);
    const r = status.rotate('admin', { hostSeals: true });
    expect(asked).toBe(1);
    expect(r).toMatchObject({ source: 'rotated', sealed: 'systemd-creds', key: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
