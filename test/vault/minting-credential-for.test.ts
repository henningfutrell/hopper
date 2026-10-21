// Issue #1761: the vault mints from the one minting credential for an account or a cluster. When several secrets mint
// for it, the vault picks none of them: it refuses and names them all, so a person keeps one.
import { describe, expect, it } from 'vitest';
import { mintingCredentialFor } from '../../src/domain/minting.ts';

const ACCOUNT = { kind: 'aws-account', name: '123456789012' } as const;
const secret = (name: string, mints?: { kind: 'aws-account' | 'cluster'; name: string }) => ({ name, ...(mints ? { mints } : {}) });

describe('the minting credential for an account or a cluster (issue #1761)', () => {
  it('is the one secret that mints for it', () => {
    const secrets = [secret('PLAIN'), secret('AWS_LAB', ACCOUNT), secret('KUBE_LAB', { kind: 'cluster', name: 'lab' }), secret('AWS_OTHER', { kind: 'aws-account', name: '999999999999' })];
    expect(mintingCredentialFor(secrets, ACCOUNT)).toBe(secrets[1]);
  });

  it('is none when no secret mints for it', () => {
    expect(mintingCredentialFor([secret('PLAIN')], ACCOUNT)).toBe('no minting credential mints for aws-account 123456789012: a person adds one on Vault');
  });

  it('is refused, with every name, when several secrets mint for it', () => {
    const said = mintingCredentialFor([secret('AWS_OLD', ACCOUNT), secret('AWS_KEY_ID', ACCOUNT), secret('AWS_KEY_SECRET', ACCOUNT)], ACCOUNT);
    expect(said).toBe('3 minting credentials mint for aws-account 123456789012: AWS_OLD, AWS_KEY_ID, AWS_KEY_SECRET. The vault does not pick one: a person keeps one on Vault and clears Mints for on the others');
  });
});
