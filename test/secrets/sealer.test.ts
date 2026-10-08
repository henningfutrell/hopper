// Issue #451: the secrets the hopper owns are kept in the database sealed (design.md "Secrets"). The
// runtime's master key (HOPPER_TOKEN_KEY) never reaches the database; each value is sealed under a key of
// its own, derived from the master key and a random salt (HKDF-SHA256), with AES-256-GCM and a random
// nonce, bound to the place it is kept (the context), padded so its length does not show, and marked with
// the master key's id so the key can be rotated (HOPPER_TOKEN_KEY_PREVIOUS opens what an old key sealed).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSealer, SecretUnreadable, sealerOf } from '../../src/secrets/sealer.ts';

const KEY = randomBytes(32).toString('hex');
const OTHER = randomBytes(32).toString('hex');
const CONTEXT = 'webhook:3f2a/signing-secret';

describe('the sealer (issue #451)', () => {
  it('opens what it sealed, in the same context', () => {
    const s = createSealer(KEY);
    expect(s.open(s.seal('the value', CONTEXT), CONTEXT)).toBe('the value');
    expect(s.open(s.seal('', CONTEXT), CONTEXT)).toBe('');
    expect(s.open(s.seal('ü—🔑', CONTEXT), CONTEXT)).toBe('ü—🔑');
  });

  it('the sealed text carries the version, the key id, a salt and a nonce, and never the value', () => {
    const s = createSealer(KEY);
    const sealed = s.seal('plain-secret-value', CONTEXT);
    expect(sealed).toMatch(/^hs1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed.split('.')[1]).toBe(s.keyId);
    expect(sealed).not.toContain('plain-secret-value');
    expect(Buffer.from(sealed.split('.')[4]!, 'base64url').toString('latin1')).not.toContain('plain-secret-value');
  });

  it('each seal is different: a fresh salt and nonce every time', () => {
    const s = createSealer(KEY);
    const a = s.seal('same', CONTEXT);
    const b = s.seal('same', CONTEXT);
    expect(a).not.toBe(b);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    expect(a.split('.')[3]).not.toBe(b.split('.')[3]);
  });

  it('the length of the value does not show, up to a block of 64 bytes', () => {
    const s = createSealer(KEY);
    expect(s.seal('a', CONTEXT).length).toBe(s.seal('a'.repeat(40), CONTEXT).length);
    expect(s.seal('a'.repeat(64), CONTEXT).length).toBeGreaterThan(s.seal('a', CONTEXT).length);
  });

  it('a value moved to another place does not open: the context is bound to it', () => {
    const s = createSealer(KEY);
    const sealed = s.seal('v', CONTEXT);
    expect(() => s.open(sealed, 'webhook:other/signing-secret')).toThrow(SecretUnreadable);
  });

  it('an altered value does not open', () => {
    const s = createSealer(KEY);
    const parts = s.seal('v', CONTEXT).split('.');
    const body = Buffer.from(parts[4]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[4] = body.toString('base64url');
    expect(() => s.open(parts.join('.'), CONTEXT)).toThrow(/altered/);
    expect(() => s.open('hs1.nonsense', CONTEXT)).toThrow(SecretUnreadable);
    expect(() => s.open('plain text', CONTEXT)).toThrow(SecretUnreadable);
  });

  it('another master key: refused naming the key id it was sealed under, never read as no secret', () => {
    const sealed = createSealer(OTHER).seal('v', CONTEXT);
    const s = createSealer(KEY);
    expect(() => s.open(sealed, CONTEXT)).toThrow(SecretUnreadable);
    expect(() => s.open(sealed, CONTEXT)).toThrow(`sealed under key ${createSealer(OTHER).keyId}`);
  });

  it('a previous key opens what it sealed; current() says it needs sealing again', () => {
    const old = createSealer(OTHER).seal('v', CONTEXT);
    const s = createSealer(KEY, [OTHER]);
    expect(s.open(old, CONTEXT)).toBe('v');
    expect(s.current(old)).toBe(false);
    expect(s.current(s.seal('v', CONTEXT))).toBe(true);
  });

  it('the key id is a fingerprint, not the key', () => {
    const s = createSealer(KEY);
    expect(s.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(KEY).not.toContain(s.keyId);
    expect(createSealer(KEY).keyId).toBe(s.keyId);
    expect(createSealer(OTHER).keyId).not.toBe(s.keyId);
  });

  it('takes the key as 64 hex digits or base64; anything else is refused', () => {
    const bytes = Buffer.from(KEY, 'hex');
    expect(createSealer(bytes.toString('base64')).keyId).toBe(createSealer(KEY).keyId);
    expect(createSealer(bytes.toString('base64url')).keyId).toBe(createSealer(KEY).keyId);
    expect(() => createSealer('short')).toThrow(/32 bytes/);
    expect(() => createSealer(KEY, ['short'])).toThrow(/HOPPER_TOKEN_KEY_PREVIOUS/);
  });
});

describe('sealerOf: the sealer under the runtime\'s key', () => {
  it('HOPPER_TOKEN_KEY, and each of HOPPER_TOKEN_KEY_PREVIOUS', () => {
    const r = sealerOf((n) => ({ HOPPER_TOKEN_KEY: KEY, HOPPER_TOKEN_KEY_PREVIOUS: `${OTHER}\n` })[n]);
    expect(r.sealer?.keyId).toBe(createSealer(KEY).keyId);
    expect(r.sealer?.open(createSealer(OTHER).seal('v', CONTEXT), CONTEXT)).toBe('v');
  });

  it('no key: no sealer, and a problem that says what to set', () => {
    const r = sealerOf(() => undefined);
    expect(r.sealer).toBeUndefined();
    expect(r.problem).toMatch(/HOPPER_TOKEN_KEY is not set/);
  });

  it('a key that is no key: throws, so the daemon does not start on it', () => {
    expect(() => sealerOf((n) => (n === 'HOPPER_TOKEN_KEY' ? 'not a key' : undefined))).toThrow(/HOPPER_TOKEN_KEY/);
  });
});
