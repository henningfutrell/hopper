// Issue #2206: an action grant. A need step's AWS change names the action no role it may use allows, and its resource;
// a person grants exactly that once, and the session is narrowed to the reads and the granted actions. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import {
  ACTION_ROLE, actionNeed, actionSession, actionsOf, granting, liveGrants, revoking, SESSION_POLICY_MAX, ungranted, type ActionGrant,
} from '../../src/domain/action-grants.ts';
import { AWS_READ_POLICY } from '../../src/domain/minting.ts';

const ROLE = `167028478405/${ACTION_ROLE}`;
const ARN = 'arn:aws:eks:us-west-1:167028478405:nodegroup/identity-eks/identity-eks-nodes/*';
const SCALE = { action: 'eks:UpdateNodegroupConfig', resource: ARN };
const AT = new Date('2026-10-19T10:00:00Z');
const hoursAfter = (h: number): Date => new Date(AT.getTime() + h * 3600_000);
const grant = (by = 'Ada', at = AT): ActionGrant => ({ role: ROLE, ...SCALE, by, at: at.toISOString() });
const write = (role: string): OperationProfile => ({ operation: 'write', asset: { kind: 'aws-role', name: role } });

describe('action grants (issue #2206)', () => {
  it('reads each action as <service:Action>=<resource ARN>, once each', () => {
    expect(actionsOf([`eks:UpdateNodegroupConfig=${ARN}`, `eks:UpdateNodegroupConfig=${ARN}`], ROLE)).toEqual([SCALE]);
    expect(actionsOf(['s3:PutObject=arn:aws:s3:::bucket/key'], ROLE)).toEqual([{ action: 's3:PutObject', resource: 'arn:aws:s3:::bucket/key' }]);
  });

  it('refuses a wildcard action, a resource that is no ARN, another account and too many actions', () => {
    expect(actionsOf([`eks:*=${ARN}`], ROLE)).toMatch(/no wildcard/);
    expect(actionsOf(['eks:UpdateNodegroupConfig'], ROLE)).toMatch(/by its ARN/);
    expect(actionsOf(['eks:UpdateNodegroupConfig=*'], ROLE)).toMatch(/by its ARN/);
    expect(actionsOf(['eks:UpdateNodegroupConfig=arn:aws:eks:*:*:nodegroup/x'], ROLE)).toMatch(/by its ARN/);
    expect(actionsOf(['eks:UpdateNodegroupConfig=arn:aws:eks:us-west-1:111111111111:nodegroup/x'], ROLE)).toMatch(/in account 111111111111, not in the account/);
    expect(actionsOf(Array.from({ length: 11 }, (_, i) => `eks:A${i}=${ARN}`), ROLE)).toMatch(/at most 10/);
  });

  it('puts the actions on the one change on an aws-role; a change on the action role needs an action', () => {
    expect(actionNeed([write(ROLE), { operation: 'read', asset: { kind: 'cluster', name: 'lab' } }], [SCALE])).toEqual(write(ROLE));
    expect(actionNeed([write(ROLE), write('167028478405/deploy')], [SCALE])).toMatch(/exactly one write, sync or apply need/);
    expect(actionNeed([{ operation: 'read', asset: { kind: 'aws-role', name: ROLE } }], [SCALE])).toMatch(/exactly one/);
    expect(actionNeed([write(ROLE)], [])).toMatch(/only for the actions a person granted/);
    expect(actionNeed([write('167028478405/deploy')], [])).toBeUndefined();
  });

  it('covers a later ask of the same role, action and resource until the time limit', () => {
    const list = granting([], grant(), AT, 24);
    expect(ungranted(liveGrants(list, 24, hoursAfter(1)), ROLE, [SCALE])).toEqual([]);
    expect(ungranted(liveGrants(list, 24, hoursAfter(1)), ROLE, [{ ...SCALE, resource: 'arn:aws:eks:us-west-1:167028478405:nodegroup/other/*' }])).toHaveLength(1);
    expect(ungranted(liveGrants(list, 24, hoursAfter(1)), '167028478405/deploy', [SCALE])).toHaveLength(1);
    expect(liveGrants(list, 24, hoursAfter(1))[0]!.expiresAt).toBe(hoursAfter(24).toISOString());
    expect(liveGrants(list, 24, hoursAfter(25))).toEqual([]);
    expect(liveGrants(list, 0, hoursAfter(9000))).toHaveLength(1);
  });

  it('replaces a grant of the same scope, and revokes it', () => {
    const two = granting(granting([], grant(), AT, 24), grant('Bea', hoursAfter(1)), hoursAfter(1), 24);
    expect(two).toEqual([grant('Bea', hoursAfter(1))]);
    expect(revoking(two, { role: ROLE, ...SCALE })).toEqual([]);
  });

  it('narrows the session to the reads and the granted actions on their resources', () => {
    const roleArn = `arn:aws:iam::167028478405:role/${ACTION_ROLE}`;
    const s = actionSession(roleArn, [SCALE]);
    if (typeof s === 'string') throw new Error(s);
    expect(s.policyArns).toEqual([AWS_READ_POLICY]);
    const policy = JSON.parse(s.policy) as { Statement: { Effect: string; Action: unknown; Resource?: unknown; NotResource?: unknown }[] };
    expect(policy.Statement).toEqual([
      { Sid: 'HopperGranted0', Effect: 'Allow', Action: SCALE.action, Resource: ARN },
      { Sid: 'HopperGrantedNoOtherRole', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:AssumeRoleWithSAML', 'sts:AssumeRoleWithWebIdentity'], NotResource: roleArn },
    ]);
    const long = Array.from({ length: 10 }, (_, i) => ({ action: `eks:UpdateNodegroupConfig${i}`, resource: `${ARN}${'x'.repeat(200)}` }));
    expect(actionSession(roleArn, long)).toMatch(new RegExp(`more than the ${SESSION_POLICY_MAX} STS takes`));
  });
});
