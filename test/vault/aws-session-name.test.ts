// Issue #781: the session name an AWS minting credential assumes a role with. By default `hopper-<job id>`; a
// credential may name a fixed `SessionName` (a trust policy that allows one name only) or a `SessionNamePrefix`
// (one that allows a prefix). Both must be names STS takes. Pure: `mintingCredentialOf` and `awsSessionName`.
import { describe, expect, it } from 'vitest';
import { awsSessionName, mintingCredentialOf, type AwsMintingCredential } from '../../src/domain/minting.ts';

const KEYS = { AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting-secret' };
const read = (extra: Record<string, unknown>) => mintingCredentialOf('aws', JSON.stringify({ ...KEYS, ...extra }));
const JOB = '0b9c6d2e-5f1a-4c3b-9e8d-7a6b5c4d3e2f';

describe('the session name an AWS minting credential assumes a role with', () => {
  it('is hopper-<job id> when the credential names none', () => {
    expect(awsSessionName(read({}) as AwsMintingCredential, JOB)).toBe(`hopper-${JOB}`);
  });

  it('is the fixed SessionName the credential names, for every job', () => {
    const c = read({ SessionName: 'p2zapwin' });
    expect(c).toMatchObject({ SessionName: 'p2zapwin' });
    expect(awsSessionName(c as AwsMintingCredential, JOB)).toBe('p2zapwin');
  });

  it('is the SessionNamePrefix and the job id, cut to the 64 characters STS takes', () => {
    expect(awsSessionName(read({ SessionNamePrefix: 'ci-' }) as AwsMintingCredential, JOB)).toBe(`ci-${JOB}`);
    const long = awsSessionName(read({ SessionNamePrefix: 'a'.repeat(32) }) as AwsMintingCredential, JOB);
    expect(long).toHaveLength(64);
    expect(long.startsWith('a'.repeat(32))).toBe(true);
  });

  it('refuses a name STS does not take, and a credential that names both', () => {
    expect(read({ SessionName: 'has space' })).toMatch(/SessionName must be 2 to 64 of letters, digits and \+ = , \. @ _ -/);
    expect(read({ SessionName: 'x' })).toMatch(/SessionName must be 2 to 64/);
    expect(read({ SessionName: 'a'.repeat(65) })).toMatch(/SessionName must be 2 to 64/);
    expect(read({ SessionNamePrefix: 'a'.repeat(33) })).toMatch(/SessionNamePrefix must be 1 to 32/);
    expect(read({ SessionNamePrefix: 'bad/' })).toMatch(/SessionNamePrefix must be 1 to 32/);
    expect(read({ SessionName: 'p2zapwin', SessionNamePrefix: 'ci-' })).toMatch(/SessionName or SessionNamePrefix, not both/);
  });
});
