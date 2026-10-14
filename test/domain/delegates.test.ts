// Issue #1138: a delegate approver's approver policy and the name its approvals record. Pure.
import { describe, expect, it } from 'vitest';
import { delegateBy, deniedBy, denyProblem, templateNames } from '../../src/domain/delegates.ts';

describe('a delegate approver (issue #1138)', () => {
  it('records the delegate and the person it acts for', () => {
    expect(delegateBy('cos', 'Owner')).toBe('cos (delegate of Owner)');
  });

  it('a deny entry matches any name that holds it, in any case; none: nothing is denied', () => {
    expect(deniedBy(['prod'], ['kube', 'shop-PROD'])).toEqual({ entry: 'prod', name: 'shop-PROD' });
    expect(deniedBy(['prod', 'uat'], ['staging', 'lab'])).toBeUndefined();
    expect(deniedBy([], ['prod'])).toBeUndefined();
  });

  it('a template\'s names: its own, its secrets, and the assets of its profiles, pending ones too', () => {
    expect(templateNames({
      name: 'kube', secrets: ['KUBE_TOKEN'], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
      pending: { secrets: ['NEW'], profiles: [{ operation: 'write', asset: { kind: 'namespace', name: 'prod/apps' } }] },
    })).toEqual(['kube', 'KUBE_TOKEN', 'lab', 'NEW', 'prod/apps']);
  });

  it('refuses an empty entry, and too many', () => {
    expect(denyProblem(['prod'])).toBeUndefined();
    expect(denyProblem([' '])).toMatch(/empty/);
    expect(denyProblem(Array.from({ length: 33 }, (_, i) => `x${i}`))).toMatch(/at most 32/);
  });
});
