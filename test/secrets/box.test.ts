// The secret box (design.md "Secrets at rest", issue #53): a secret the hopper itself keeps — a
// webhook subscription's generated secret — is stored sealed (AES-256-GCM) under JOB_HOPPER_SECRET_KEY,
// never in clear.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, secretKeyProblem } from '../../src/secrets/box.ts';
import { TEST_SECRET_KEY } from '../support/secret-key.ts';

const box = createSecretBox(TEST_SECRET_KEY);

describe('the secret box', () => {
  it('seals to an opaque value that unseals to the secret', () => {
    const sealed = box.seal('s-grok');
    expect(sealed).toMatch(/^sealed:v1:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('s-grok');
    expect(box.isSealed(sealed)).toBe(true);
    expect(box.isSealed('s-grok')).toBe(false);
    expect(box.unseal(sealed)).toBe('s-grok');
  });

  it('seals the same secret differently every time (a fresh nonce)', () => {
    const a = box.seal('same');
    const b = box.seal('same');
    expect(a).not.toBe(b);
    expect([box.unseal(a), box.unseal(b)]).toEqual(['same', 'same']);
  });

  it('boundaries: an empty secret and a long one', () => {
    expect(box.unseal(box.seal(''))).toBe('');
    const long = randomBytes(4096).toString('hex');
    expect(box.unseal(box.seal(long))).toBe(long);
  });

  it('refuses a tampered value, a plain one and one sealed under another key, naming the key', () => {
    const sealed = box.seal('s-grok');
    const i = 'sealed:v1:'.length + 20; // inside the tag: every bit counts
    const tampered = sealed.slice(0, i) + (sealed[i] === 'A' ? 'B' : 'A') + sealed.slice(i + 1);
    expect(() => box.unseal(tampered)).toThrow(/cannot unseal/);
    expect(() => box.unseal('s-grok')).toThrow(/not a sealed secret/);
    const other = createSecretBox(randomBytes(32).toString('base64'));
    expect(() => other.unseal(sealed)).toThrow(/JOB_HOPPER_SECRET_KEY/);
  });

  it('a key is 32 bytes, base64; anything else is refused', () => {
    expect(secretKeyProblem(TEST_SECRET_KEY)).toBeUndefined();
    expect(secretKeyProblem(randomBytes(32).toString('base64url'))).toBeUndefined();
    for (const bad of ['', 'short', randomBytes(16).toString('base64'), randomBytes(64).toString('base64'), 'not base64 at all!!']) {
      expect(secretKeyProblem(bad)).toMatch(/32 bytes/);
    }
    expect(() => createSecretBox('short')).toThrow(/32 bytes/);
  });
});
