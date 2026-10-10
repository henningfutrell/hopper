// Issue #659: the master key comes from the launch, never from a volume. HOPPER_MASTER_KEY gives it; a fingerprint of
// it (an HMAC of a fixed label, never the key) is kept in the database and checked at each start. A fresh hopper with
// no key makes one, to be shown once; a hopper that keeps secrets and gets no key starts limited, and makes none. The
// old token key (HOPPER_TOKEN_KEY, or the file HOPPER_TOKEN_KEY_FILE names) is read only to move it to HOPPER_MASTER_KEY.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintOf, MasterKeyMismatch, resolveMasterKey, withMasterKey, type KeptSecrets } from '../../src/secrets/master-key.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';

const KEY = randomBytes(32).toString('hex');
const OTHER = randomBytes(32).toString('hex');
const NONE: KeptSecrets = { keyIds: [], tokens: [] };

/** The fingerprint as the database keeps it, in memory. */
function recordOf(fingerprint?: string) {
  const r = { fingerprint, fingerprintOf: () => r.fingerprint, setFingerprint: (fp: string) => { r.fingerprint = fp; } };
  return r;
}

const resolve = (env: Record<string, string | undefined>, record = recordOf(), kept: KeptSecrets = NONE) =>
  resolveMasterKey({ env, record: { fingerprint: record.fingerprintOf, setFingerprint: record.setFingerprint }, kept: () => kept });

describe('the master key (issue #659)', () => {
  it('the fingerprint is an HMAC of a fixed label: the same for the same key, never the key', () => {
    expect(fingerprintOf(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(KEY)).toBe(fingerprintOf(KEY));
    expect(fingerprintOf(KEY)).not.toBe(fingerprintOf(OTHER));
    expect(fingerprintOf(KEY)).not.toContain(KEY);
  });

  it('given as HOPPER_MASTER_KEY on a fresh database: used, and its fingerprint recorded', () => {
    const record = recordOf();
    const r = resolve({ HOPPER_MASTER_KEY: KEY }, record);
    expect(r).toMatchObject({ source: 'given', key: KEY });
    expect(record.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('given and matching the recorded fingerprint: used, nothing changed', () => {
    const record = recordOf(fingerprintOf(KEY));
    expect(resolve({ HOPPER_MASTER_KEY: KEY }, record)).toMatchObject({ source: 'given', key: KEY });
    expect(record.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('a wrong key: refused, saying it does not match this database; the fingerprint stays', () => {
    const record = recordOf(fingerprintOf(KEY));
    expect(() => resolve({ HOPPER_MASTER_KEY: OTHER }, record)).toThrow(MasterKeyMismatch);
    expect(() => resolve({ HOPPER_MASTER_KEY: OTHER }, record)).toThrow('the master key does not match this database');
    expect(record.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('a wrong key on a database whose secrets carry no fingerprint yet: refused when it seals none of them', () => {
    const sealed = createSealer(KEY).seal('v', 'webhook:1/signing-secret');
    const token = createTokenBox(KEY).seal('gho_token');
    const record = recordOf();
    expect(() => resolve({ HOPPER_MASTER_KEY: OTHER }, record, { keyIds: [sealed.split('.')[1]!], tokens: [] })).toThrow(MasterKeyMismatch);
    expect(() => resolve({ HOPPER_MASTER_KEY: OTHER }, record, { keyIds: [], tokens: [token] })).toThrow(MasterKeyMismatch);
    expect(record.fingerprint).toBeUndefined();
    expect(resolve({ HOPPER_MASTER_KEY: KEY }, record, { keyIds: [], tokens: [token] })).toMatchObject({ source: 'given' });
    expect(record.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('a new key with the recorded one as HOPPER_MASTER_KEY_PREVIOUS: used, and the new fingerprint recorded', () => {
    const record = recordOf(fingerprintOf(KEY));
    expect(resolve({ HOPPER_MASTER_KEY: OTHER, HOPPER_MASTER_KEY_PREVIOUS: KEY }, record)).toMatchObject({ source: 'given', key: OTHER, previous: [KEY] });
    expect(record.fingerprint).toBe(fingerprintOf(OTHER));
  });

  it('a key that is no key: refused', () => {
    expect(() => resolve({ HOPPER_MASTER_KEY: 'short' })).toThrow('HOPPER_MASTER_KEY must be 32 bytes');
  });

  it('never read from a file: HOPPER_MASTER_KEY_FILE is refused, naming the variable to use', () => {
    expect(() => resolve({ HOPPER_MASTER_KEY_FILE: '/run/secrets/key' })).toThrow('give the key as HOPPER_MASTER_KEY');
  });

  it('none on a fresh database: a new key is made, and its fingerprint recorded', () => {
    const record = recordOf();
    const r = resolve({}, record);
    expect(r.source).toBe('generated');
    const key = (r as { key: string }).key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fingerprint).toBe(fingerprintOf(key));
  });

  it('none, with a fingerprint recorded: limited, naming the key it needs; no key made', () => {
    const record = recordOf(fingerprintOf(KEY));
    const r = resolve({}, record);
    expect(r).toMatchObject({ source: 'missing' });
    expect((r as { problem: string }).problem).toContain('HOPPER_MASTER_KEY');
    expect((r as { problem: string }).problem).toContain(fingerprintOf(KEY).slice(0, 16));
    expect(record.fingerprint).toBe(fingerprintOf(KEY));
  });

  it('none, with sealed secrets and no fingerprint: limited; no key made, nothing recorded', () => {
    const record = recordOf();
    expect(resolve({}, record, { keyIds: ['0123456789abcdef'], tokens: [] })).toMatchObject({ source: 'missing' });
    expect(resolve({}, record, { keyIds: [], tokens: [createTokenBox(KEY).seal('t')] })).toMatchObject({ source: 'missing' });
    expect(record.fingerprint).toBeUndefined();
  });

  describe('the old token key', () => {
    const fileOf = (text: string): string => {
      const path = join(mkdtempSync(join(tmpdir(), 'hopper-key-')), 'token_key');
      writeFileSync(path, `${text}\n`);
      return path;
    };

    it('read from the old volume\'s file when HOPPER_MASTER_KEY is not set: used, to be saved; fingerprint recorded', () => {
      const record = recordOf();
      const sealed = createSealer(KEY).seal('v', 'webhook:1/signing-secret');
      const r = resolve({ HOPPER_TOKEN_KEY_FILE: fileOf(KEY) }, record, { keyIds: [sealed.split('.')[1]!], tokens: [] });
      expect(r).toMatchObject({ source: 'old-token-key', key: KEY });
      expect(record.fingerprint).toBe(fingerprintOf(KEY));
    });

    it('read from HOPPER_TOKEN_KEY too', () => {
      expect(resolve({ HOPPER_TOKEN_KEY: KEY })).toMatchObject({ source: 'old-token-key', key: KEY });
    });

    it('a file that is not there is no old key: a fresh hopper makes one', () => {
      expect(resolve({ HOPPER_TOKEN_KEY_FILE: join(tmpdir(), 'no-such-dir-659', 'token_key') }).source).toBe('generated');
    });

    it('one that seals none of the kept secrets: limited, saying so; nothing recorded', () => {
      const record = recordOf();
      const sealed = createSealer(KEY).seal('v', 'webhook:1/signing-secret');
      const r = resolve({ HOPPER_TOKEN_KEY_FILE: fileOf(OTHER) }, record, { keyIds: [sealed.split('.')[1]!], tokens: [] });
      expect(r).toMatchObject({ source: 'missing' });
      expect((r as { problem: string }).problem).toContain('the old token key does not match this database');
      expect(record.fingerprint).toBeUndefined();
    });

    it('not read once HOPPER_MASTER_KEY is set: the answer says it can go', () => {
      const r = resolve({ HOPPER_MASTER_KEY: KEY, HOPPER_TOKEN_KEY_FILE: fileOf(KEY) }, recordOf(fingerprintOf(KEY)));
      expect(r).toMatchObject({ source: 'given', key: KEY });
      expect((r as { notes: string[] }).notes.join('\n')).toContain('can be removed');
    });
  });

  it('withMasterKey: the parts read the resolved key, and no file or old variable', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', HOPPER_MASTER_KEY_FILE: '/x', HOPPER_TOKEN_KEY: OTHER, HOPPER_TOKEN_KEY_FILE: '/y' };
    const keyed = withMasterKey(env, { key: KEY, previous: [OTHER] });
    expect(keyed.HOPPER_MASTER_KEY).toBe(KEY);
    expect(keyed.HOPPER_MASTER_KEY_PREVIOUS).toBe(OTHER);
    expect(keyed.HOPPER_MASTER_KEY_FILE).toBeUndefined();
    expect(keyed.HOPPER_TOKEN_KEY).toBeUndefined();
    expect(keyed.HOPPER_TOKEN_KEY_FILE).toBeUndefined();
    expect(keyed.PATH).toBe('/bin');
    env.LATER = 'set while running';
    expect(keyed.LATER).toBe('set while running');
    expect(withMasterKey(env, undefined).HOPPER_MASTER_KEY).toBeUndefined();
  });
});
