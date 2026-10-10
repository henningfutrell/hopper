// Masking GitHub tokens in text (issue #597): job progress, results, GitHub proxy posts.
import { describe, expect, it } from 'vitest';
import { maskGitHubTokens } from '../../src/secrets/mask.ts';

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
