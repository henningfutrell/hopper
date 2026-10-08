// A connected account's tokens are sealed at rest (issue #441): AES-256-GCM under the runtime's
// HOPPER_TOKEN_KEY, so a dump or backup of the database holds no usable GitHub token.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenBox, tokenKeyProblem } from '../../src/secrets/token-box.ts';

const hex = randomBytes(32).toString('hex');

describe('the token box', () => {
  it('seals and opens a token; each seal differs', () => {
    const box = createTokenBox(hex);
    const a = box.seal('ghr_secret');
    expect(a).toMatch(/^sealed:v1:/);
    expect(a).not.toContain('ghr_secret');
    expect(box.seal('ghr_secret')).not.toBe(a);
    expect(box.open(a)).toBe('ghr_secret');
  });

  it('takes the key as 64 hex digits or as base64 of 32 bytes', () => {
    const bytes = randomBytes(32);
    expect(createTokenBox(bytes.toString('base64')).open(createTokenBox(bytes.toString('hex')).seal('t'))).toBe('t');
    expect(tokenKeyProblem('short')).toMatch(/32 bytes/);
    expect(() => createTokenBox('short')).toThrow(/HOPPER_TOKEN_KEY must be 32 bytes/);
  });

  it('refuses a token sealed under another key, naming the variable', () => {
    const sealed = createTokenBox(hex).seal('t');
    expect(() => createTokenBox(randomBytes(32).toString('hex')).open(sealed)).toThrow(/another HOPPER_TOKEN_KEY/);
  });

  it('knows a sealed value from a clear one', () => {
    const box = createTokenBox(hex);
    expect(box.isSealed(box.seal('t'))).toBe(true);
    expect(box.isSealed('gho_clear')).toBe(false);
  });

  it('opens with an older key given as HOPPER_TOKEN_KEY_PREVIOUS, and knows it was not sealed under the current one (#514)', () => {
    const old = randomBytes(32).toString('hex');
    const sealed = createTokenBox(old).seal('ghr_secret');
    const box = createTokenBox(hex, [old]);
    expect(box.open(sealed)).toBe('ghr_secret');
    expect(box.current(sealed)).toBe(false);
    expect(box.current(box.seal('t'))).toBe(true);
    expect(() => createTokenBox(hex, ['short'])).toThrow(/HOPPER_TOKEN_KEY_PREVIOUS must be 32 bytes/);
  });
});
