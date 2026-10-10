// GitHub tokens are masked in text a job gives (issue #597).
import { describe, expect, it } from 'vitest';
import { MASKED_TOKEN, maskTokens, maskTokensIn } from '../../src/secrets/mask.ts';

const T = 'A'.repeat(36);

describe('maskTokens (#597)', () => {
  it('masks every GitHub token shape, and only those', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) expect(maskTokens(`token=${prefix}${T} done`)).toBe(`token=${MASKED_TOKEN} done`);
    expect(maskTokens(`github_pat_11AB_${T}x`)).toBe(MASKED_TOKEN);
    expect(maskTokens(`two: gho_${T}, ghr_${T}.`)).toBe(`two: ${MASKED_TOKEN}, ${MASKED_TOKEN}.`);
    expect(maskTokens('ghost_writer gho_short ghp_ github_pat_ plain text')).toBe('ghost_writer gho_short ghp_ github_pat_ plain text');
  });
});

describe('maskTokensIn (#597)', () => {
  it('masks the text of a JSON result and keeps its shape', () => {
    expect(maskTokensIn({ note: `used gho_${T}`, n: 2, list: [`ghs_${T}`] })).toEqual({ note: `used ${MASKED_TOKEN}`, n: 2, list: [MASKED_TOKEN] });
    expect(maskTokensIn(`ghu_${T}`)).toBe(MASKED_TOKEN);
    expect(maskTokensIn(undefined)).toBeUndefined();
    expect(maskTokensIn(3)).toBe(3);
  });
});
