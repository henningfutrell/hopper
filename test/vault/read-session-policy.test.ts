// Issue #715: a read session the vault mints from STS carries two session policies. AWS's managed `ReadOnlyAccess`
// gives what the session may read; an inline policy of explicit denies takes away every write a role's own policy
// could still allow, and every role but the session's own. An explicit deny wins over any allow, so the role's policy
// cannot widen it. Pure: `mintTarget`. The policy reaching STS: test/integration/vault-mint.test.ts.
//
// Feature: the read session's deny policy
//   Scenario: a read session carries ReadOnlyAccess and an inline policy that denies every write and every other role
//   Scenario: a write session carries neither
import { describe, expect, it } from 'vitest';
import { AWS_READ_POLICY, mintTarget } from '../../src/domain/minting.ts';

interface Statement { Effect: string; Action?: string[]; NotAction?: string[]; Resource?: string; NotResource?: string }

const target = (operation: 'read' | 'write') => mintTarget('aws', { operation, asset: { kind: 'aws-role', name: '123456789012/diag' } });

describe('the read session\'s deny policy (issue #715)', () => {
  it('a read session carries ReadOnlyAccess and an inline policy that denies every write and every other role', () => {
    const t = target('read');
    if (typeof t === 'string' || t.kind !== 'aws') throw new Error(String(t));
    expect(t.policyArns).toEqual([AWS_READ_POLICY]);
    const policy = JSON.parse(t.policy!) as { Version: string; Statement: Statement[] };
    expect(policy.Version).toBe('2012-10-17');
    // Only denies: an allow in a session policy could add to what ReadOnlyAccess gives.
    expect(policy.Statement.every((s) => s.Effect === 'Deny')).toBe(true);
    const denied = policy.Statement.flatMap((s) => s.Action ?? []);
    for (const a of ['*:Create*', '*:Delete*', '*:Put*', '*:Update*', 'iam:Attach*', 'iam:Detach*', 'iam:PassRole', 'iam:Tag*']) expect(denied).toContain(a);
    const roles = policy.Statement.find((s) => s.Action?.includes('sts:AssumeRole'))!;
    expect(roles.NotResource).toBe('arn:aws:iam::123456789012:role/diag');
    expect(roles.Resource).toBeUndefined();
    // STS takes at most 2048 characters of inline session policy.
    expect(t.policy!.length).toBeLessThanOrEqual(2048);
  });

  it('a write session carries neither', () => {
    const t = target('write');
    if (typeof t === 'string' || t.kind !== 'aws') throw new Error(String(t));
    expect(t.policyArns).toEqual([]);
    expect(t.policy).toBeUndefined();
  });
});
