// Issue #1472: the standing read grant covers only a template whose needs the read policy holds entirely as reads, and
// that holds no vault secret. Any write, sync or apply, a read outside the policy, or a secret keeps the per-job grant.
import { describe, expect, it } from 'vitest';
import { readsOnlyInPolicy } from '../../src/domain/vault-grants.ts';

const utility = { kind: 'cluster' as const, name: 'utility' };
const policy = { assets: ['cluster/utility', 'aws-account/1234*'] };

describe('what the standing read grant covers (issue #1472)', () => {
  it('a template of reads the policy holds, with no vault secret', () => {
    expect(readsOnlyInPolicy({ secrets: [], profiles: [{ operation: 'read', asset: utility }] }, policy)).toBe(true);
    expect(readsOnlyInPolicy({ secrets: [], profiles: [{ operation: 'read', asset: utility }, { operation: 'read', asset: { kind: 'aws-account', name: '123456789012' } }] }, policy)).toBe(true);
  });

  it('not a template with a write, a read outside the policy, a vault secret, or no needs at all', () => {
    expect(readsOnlyInPolicy({ secrets: [], profiles: [{ operation: 'read', asset: utility }, { operation: 'write', asset: utility }] }, policy)).toBe(false);
    expect(readsOnlyInPolicy({ secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'prod' } }] }, policy)).toBe(false);
    expect(readsOnlyInPolicy({ secrets: ['KUBE_TOKEN'], profiles: [{ operation: 'read', asset: utility }] }, policy)).toBe(false);
    expect(readsOnlyInPolicy({ secrets: [], profiles: [] }, policy)).toBe(false);
    expect(readsOnlyInPolicy({ secrets: [], profiles: [{ operation: 'read', asset: utility }] }, undefined)).toBe(false);
  });
});
