// The request's capabilities against the stamp's (issue #655, part 16): gate 2's policy stage at the skill broker. A
// job's stamp may ask only for the operation profiles whose minimum trust its level meets (part 15). A need above it is
// declined by policy before Jev or a person reads it, and the job's trust stays. Pure.
import { describe, expect, it } from 'vitest';
import type { MinTrust, OperationProfile } from '../../src/domain/types.ts';
import { outsideStamp } from '../../src/domain/stamp-capabilities.ts';

const READ_X: OperationProfile = { operation: 'read', asset: { kind: 'cluster', name: 'x' } };
const WRITE_X: OperationProfile = { operation: 'write', asset: { kind: 'cluster', name: 'x' } };
const min = (profile: OperationProfile, level: MinTrust['level']): MinTrust => ({ profile, level, setBy: 'admin', setAt: '2026-10-17T10:00:00.000Z' });

describe('the request\'s capabilities against the stamp\'s', () => {
  it('lets a need with no minimum trust, and one whose minimum the level meets', () => {
    expect(outsideStamp('untrusted', [READ_X], [])).toBeUndefined();
    expect(outsideStamp('trusted', [WRITE_X], [min(WRITE_X, 'trusted')])).toBeUndefined();
    expect(outsideStamp('owner', [READ_X, WRITE_X], [min(WRITE_X, 'trusted'), min(READ_X, 'approved')])).toBeUndefined();
  });

  it('says why a need above the level is outside the stamp: the first such need', () => {
    expect(outsideStamp('approved', [READ_X, WRITE_X], [min(WRITE_X, 'trusted')]))
      .toBe('the job\'s trust stamp is approved, below the minimum trust trusted to write on cluster x');
  });

  it('compares the whole profile: another operation or asset is not gated', () => {
    expect(outsideStamp('screened', [READ_X], [min(WRITE_X, 'owner')])).toBeUndefined();
    expect(outsideStamp('screened', [{ operation: 'write', asset: { kind: 'cluster', name: 'y' } }], [min(WRITE_X, 'owner')])).toBeUndefined();
  });

  it('fails closed: a quarantined job, and a job whose stamp does not verify, meet no minimum', () => {
    expect(outsideStamp('quarantined', [READ_X], [min(READ_X, 'untrusted')]))
      .toBe('the job\'s trust stamp is quarantined, below the minimum trust untrusted to read on cluster x');
    expect(outsideStamp(undefined, [READ_X], [min(READ_X, 'untrusted')]))
      .toBe('the job has no trust stamp that verifies, so it meets no minimum trust: the minimum trust untrusted to read on cluster x');
    expect(outsideStamp(undefined, [READ_X], [])).toBeUndefined();
  });
});
