// Issue #718: shared secrets on Vault, the page's pure model. Each says whose agents may read it, who set it
// and when; the readers the hopper's admin types are user ids, comma- or space-separated, or none for every user.
import { describe, expect, it } from 'vitest';
import { readersOf, sharedReadersText, sharedSecretLine } from '../../ui/src/model/vault-shared.ts';
import type { SharedSecretView } from '../../ui/src/model/wire.ts';

const AT = '2026-10-10T12:00:00Z';
const secret = (o: Partial<SharedSecretView> = {}): SharedSecretView => ({ name: 'shared/AWS_DIAG', setBy: 'Ada', createdAt: AT, changedBy: 'Ada', changedAt: AT, ...o });

describe('a shared secret on the page (issue #718)', () => {
  it('says whose agents may read it', () => {
    expect(sharedReadersText(secret())).toBe('every user\'s agents');
    expect(sharedReadersText(secret({ readers: ['u1', 'u2'] }))).toBe('the agents of u1, u2');
  });

  it('says who set it last and when, and that it is sealed', () => {
    expect(sharedSecretLine(secret({ changedBy: 'Bea' }))).toMatch(/^Set — .* by Bea · sealed$/);
  });

  it('reads the readers typed: none is every user; a user id holds no space, : or #', () => {
    expect(readersOf('')).toBeUndefined();
    expect(readersOf('  ')).toBeUndefined();
    expect(readersOf('u1, u2 u3,,u1')).toEqual(['u1', 'u2', 'u3']);
  });
});
