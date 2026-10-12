// Issue #715: a read session the vault mints from STS carries two session policies. AWS's managed `ReadOnlyAccess`
// gives what the session may read; an inline policy of explicit denies takes away every write a role's own policy
// could still allow, and every role but the session's own. An explicit deny wins over any allow, so the role's policy
// cannot widen it. Pure: `mintTarget`. The policy reaching STS: test/integration/vault-mint.test.ts.
// Issue #853: STS refused the first deny policy whole (`*:Create*`: IAM takes no wildcard in a service prefix), and a
// fake STS did not see it. So the policy is checked here against IAM's policy grammar and AWS's list of services and
// actions (`@cloud-copilot/iam-policy`, `@cloud-copilot/iam-data`), as STS checks it.
//
// Feature: the read session's deny policy
//   Scenario: a read session carries ReadOnlyAccess and an inline policy that denies every write and every other role
//   Scenario: a write session carries neither
//   Scenario: STS takes the read session's policy: valid IAM grammar, real services and actions, 2048 characters at most
//   Scenario: terraform's state backend is read-only under a read session: it reads the state, and writes no state and no lock
import { describe, expect, it } from 'vitest';
import { iamActionsForService, iamServiceExists } from '@cloud-copilot/iam-data';
import { validateSessionPolicy } from '@cloud-copilot/iam-policy';
import { AWS_READ_POLICY, mintTarget } from '../../src/domain/minting.ts';

interface Statement { Effect: string; Action?: string[]; NotAction?: string[]; Resource?: string; NotResource?: string }

/** Whether an IAM action pattern (`*` and `?`, case-insensitive, as IAM matches them) matches the action. */
const matches = (pattern: string, action: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i').test(action);

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
    const isDenied = (action: string): boolean => denied.some((p) => matches(p, action));
    // The writes the read-only check's probes try (src/sandbox/probes.ts), and IAM's.
    for (const write of ['ec2:CreateTags', 'ec2:CreateVpc', 'ssm:PutParameter', 'ssm:DeleteParameter', 'iam:CreateUser', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PassRole', 'iam:TagRole']) expect(isDenied(write), write).toBe(true);
    for (const read of ['sts:GetCallerIdentity', 'ec2:DescribeVpcs', 'ssm:GetParameter', 'iam:GetRole', 'iam:ListRoles']) expect(isDenied(read), read).toBe(false);
    const roles = policy.Statement.find((s) => s.Action?.includes('sts:AssumeRole'))!;
    expect(roles.NotResource).toBe('arn:aws:iam::123456789012:role/diag');
    expect(roles.Resource).toBeUndefined();
  });

  it('STS takes the read session\'s policy: valid IAM grammar, real services and actions, 2048 characters at most', async () => {
    // The longest role name IAM takes: 64 characters.
    const t = mintTarget('aws', { operation: 'read', asset: { kind: 'aws-role', name: `123456789012/${'r'.repeat(64)}` } });
    if (typeof t === 'string' || t.kind !== 'aws') throw new Error(String(t));
    expect(t.policy!.length).toBeLessThanOrEqual(2048);
    const policy = JSON.parse(t.policy!) as { Statement: Statement[] };
    expect(validateSessionPolicy(policy)).toEqual([]);
    const byService = new Map<string, string[]>();
    for (const pattern of policy.Statement.flatMap((s) => s.Action ?? [])) {
      const [service = '', action = ''] = pattern.split(':');
      expect(await iamServiceExists(service), pattern).toBe(true);
      byService.set(service, [...(byService.get(service) ?? []), action]);
    }
    // A name with a typo matches no action. A verb a service has no action for yet still denies its later ones, so
    // each service's patterns together must match an action, and each pattern that names more than a verb must.
    for (const [service, patterns] of byService) {
      const actions = await iamActionsForService(service);
      const matched = (p: string): boolean => actions.some((a) => matches(p, a));
      expect(patterns.some(matched), service).toBe(true);
      for (const p of patterns.filter((x) => !/^[A-Z][a-z]+\*$/.test(x))) expect(matched(p), `${service}:${p}`).toBe(true);
    }
  });

  it('a write session carries neither', () => {
    const t = target('write');
    if (typeof t === 'string' || t.kind !== 'aws') throw new Error(String(t));
    expect(t.policyArns).toEqual([]);
    expect(t.policy).toBeUndefined();
  });

  it('terraform\'s state backend is read-only under a read session: it reads the state, and writes no state and no lock', () => {
    const t = target('read');
    if (typeof t === 'string' || t.kind !== 'aws') throw new Error(String(t));
    const denied = (JSON.parse(t.policy!) as { Statement: Statement[] }).Statement.flatMap((s) => s.Action ?? []);
    const isDenied = (action: string): boolean => denied.some((p) => matches(p, action));
    // The S3 backend's state writes, and its lock: a DynamoDB item, or (use_lockfile) an S3 object.
    for (const write of ['s3:PutObject', 's3:DeleteObject', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem']) expect(isDenied(write), write).toBe(true);
    // What plan, show, output and state list read: ReadOnlyAccess allows them, and the deny policy leaves them.
    for (const read of ['s3:GetObject', 's3:ListBucket', 's3:GetBucketVersioning', 'dynamodb:GetItem', 'dynamodb:DescribeTable']) expect(isDenied(read), read).toBe(false);
  });
});
