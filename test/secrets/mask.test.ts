// Masking GitHub tokens in text (issue #597): job progress, results, GitHub proxy posts. Masking keys in log lines (issue #685).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { maskGitHubTokens, maskKeys, maskLogLine } from '../../src/secrets/mask.ts';

const body = (n: number): string => 'aB3'.repeat(Math.ceil(n / 3)).slice(0, n);
const stars = (prefix: string, n: number): string => `${prefix}${'*'.repeat(n)} (masked)`;

describe('maskGitHubTokens', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_']) {
    it(`masks ${prefix} tokens`, () => {
      expect(maskGitHubTokens(`Using ${prefix}${body(36)} to auth`)).toBe(`Using ${stars(prefix, 36)} to auth`);
    });
  }

  it('masks refresh tokens (ghr_)', () => {
    expect(maskGitHubTokens(`Refresh: ghr_${body(76)}`)).toBe(`Refresh: ${stars('ghr_', 76)}`);
  });

  it('masks fine-grained PATs (github_pat_)', () => {
    expect(maskGitHubTokens(`PAT: github_pat_${body(82)}`)).toBe(`PAT: ${stars('github_pat_', 82)}`);
  });

  it('masks tokens of other lengths too', () => {
    expect(maskGitHubTokens(`t ghu_${body(40)}`)).toBe(`t ${stars('ghu_', 40)}`);
  });

  it('masks multiple tokens in one text, across lines', () => {
    expect(maskGitHubTokens(`a ghp_${body(36)}\nb ghu_${body(36)}\nc`)).toBe(`a ${stars('ghp_', 36)}\nb ${stars('ghu_', 36)}\nc`);
  });

  it('leaves text without tokens unchanged', () => {
    const text = 'No tokens here, ghp_short, just some regular text';
    expect(maskGitHubTokens(text)).toBe(text);
  });

  it('does not mask a token glued to a word before it', () => {
    const text = `prefix_ghp_${body(36)}`;
    expect(maskGitHubTokens(text)).toBe(text);
  });
});

// Issue #685: a key the hopper makes or is given never reaches a log line. The master key is 32 bytes as 64 hex digits
// or base64; every other key the hopper makes is 32 random bytes as 64 hex digits or base64url.
describe('maskKeys', () => {
  const hex = randomBytes(32).toString('hex');

  it('masks a 64-hex key, the master key\'s form, and every 32-byte hex key the hopper makes', () => {
    expect(maskKeys(`the key: ${hex}`)).toBe('the key: [key, masked]');
    expect(maskKeys(`HOPPER_MASTER_KEY=${hex.toUpperCase()}\n`)).toBe('HOPPER_MASTER_KEY=[key, masked]\n');
  });

  it('masks a 32-byte key as base64 or base64url', () => {
    const bytes = Buffer.from(hex, 'hex');
    expect(maskKeys(`k ${bytes.toString('base64')} end`)).toBe('k [key, masked] end');
    expect(maskKeys(`token ${bytes.toString('base64url')}`)).toBe('token [key, masked]');
  });

  it('leaves a sha256 digest, a 16-digit fingerprint, a commit id and a long word unchanged', () => {
    const text = `image sha256:${hex}, fingerprint ${hex.slice(0, 16)}, commit ${hex.slice(0, 40)}, branch issue-685-never-write-the-master-key-to-the`;
    expect(maskKeys(text)).toBe(text);
  });

  it('leaves a longer hex run unchanged as a whole: it is no 32-byte key', () => {
    const text = `${hex}${hex}`;
    expect(maskKeys(text)).toBe(text);
  });
});

describe('maskLogLine', () => {
  it('masks the secrets it holds in any form, the key patterns and GitHub tokens', () => {
    const held = 'not-hex-but-held-0123456789';
    const line = `a ${held} b ghp_${body(36)} c ${randomBytes(32).toString('hex')}`;
    expect(maskLogLine(line, [held])).toBe(`a [secret, masked] b ${stars('ghp_', 36)} c [key, masked]`);
  });
});
