// Masking GitHub tokens in text (issue #597): job progress, results, GitHub proxy posts.
import { describe, expect, it } from 'vitest';
import { maskGitHubTokens } from '../../src/secrets/mask.ts';

describe('maskGitHubTokens', () => {
  it('masks OAuth app tokens (ghp_)', () => {
    const text = 'Using token ghp_0123456789abcdef0123456789abcdef to auth';
    expect(maskGitHubTokens(text)).toBe('Using token ghp_******************************** (masked) to auth');
  });

  it('masks old OAuth app tokens (gho_)', () => {
    const text = 'Token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    expect(maskGitHubTokens(text)).toBe('Token: gho_******************************** (masked)');
  });

  it('masks GitHub App user tokens (ghu_)', () => {
    const text = 'Authorization: Bearer ghu_1234567890abcdefghijklmnopqrstu';
    expect(maskGitHubTokens(text)).toBe('Authorization: Bearer ghu_******************************** (masked)');
  });

  it('masks GitHub App server tokens (ghs_)', () => {
    const text = 'Server token ghs_XYZ123ABC456DEF789GHI012JKL345M';
    expect(maskGitHubTokens(text)).toBe('Server token ghs_******************************** (masked)');
  });

  it('masks refresh tokens (ghr_)', () => {
    const text = 'Refresh: ghr_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567';
    expect(maskGitHubTokens(text)).toBe('Refresh: ghr_******************************************************************** (masked)');
  });

  it('masks fine-grained PATs (github_pat_)', () => {
    const text = 'PAT: github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789ABC';
    expect(maskGitHubTokens(text)).toBe('PAT: github_pat_************************************************************************** (masked)');
  });

  it('masks multiple tokens in one text', () => {
    const text = 'Token1: ghp_0123456789abcdef0123456789abcdef and token2: ghu_abcdef0123456789abcdef01234567';
    expect(maskGitHubTokens(text)).toBe('Token1: ghp_******************************** (masked) and token2: ghu_******************************** (masked)');
  });

  it('preserves text without tokens unchanged', () => {
    const text = 'No tokens here, just some regular text';
    expect(maskGitHubTokens(text)).toBe(text);
  });

  it('only masks tokens with word boundaries', () => {
    const text = 'prefix_ghp_0123456789abcdef0123456789abcdef_suffix should not mask, but ghp_0123456789abcdef0123456789abcdef should';
    expect(maskGitHubTokens(text)).toContain('prefix_ghp_0123456789abcdef0123456789abcdef_suffix should not mask');
    expect(maskGitHubTokens(text)).toContain('ghp_******************************** (masked) should');
  });

  it('masks tokens in multiline text', () => {
    const text = `First line with ghp_0123456789abcdef0123456789abcdef
Second line
Third line with ghu_abcdef0123456789abcdef01234567`;
    const masked = maskGitHubTokens(text);
    expect(masked).toContain('ghp_******************************** (masked)');
    expect(masked).toContain('ghu_******************************** (masked)');
    expect(masked).toContain('Second line');
  });

  it('handles empty string', () => {
    expect(maskGitHubTokens('')).toBe('');
  });

  it('handles strings with only tokens', () => {
    const text = 'ghp_0123456789abcdef0123456789abcdef';
    expect(maskGitHubTokens(text)).toBe('ghp_******************************** (masked)');
  });
});
