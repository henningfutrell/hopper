// Issue #2206, part 2: the action check. Before a job's template is made, the hopper says which of the AWS actions its
// change names the minted session cannot do: the role does not allow it (IAM's policy simulation), or, on the action
// role, no person granted it yet. Pure.
import { describe, expect, it } from 'vitest';
import { ACTION_ROLE, type ActionGrant } from '../../src/domain/action-grants.ts';
import { actionCheckLines, actionChecks, cannotRun } from '../../src/domain/action-check.ts';

const ACCOUNT = '167028478405';
const ARN = `arn:aws:eks:us-west-1:${ACCOUNT}:nodegroup/identity-eks/identity-eks-nodes/*`;
const SCALE = { action: 'eks:UpdateNodegroupConfig', resource: ARN };
const TAG = { action: 'eks:TagResource', resource: ARN };
const ACTIONS = `${ACCOUNT}/${ACTION_ROLE}`, DEPLOY = `${ACCOUNT}/deploy`;
const granted = (role: string): ActionGrant => ({ role, ...SCALE, by: 'Ada', at: '2026-10-19T10:00:00Z' });

describe('the action check (issue #2206, part 2)', () => {
  it('on another role: an action the role allows is ready, one it does not is denied by the role', () => {
    const checks = actionChecks(DEPLOY, [SCALE, TAG], [], { allowed: [SCALE], denied: [TAG] });
    expect(checks.map((c) => [c.action, c.verdict])).toEqual([['eks:UpdateNodegroupConfig', 'ready'], ['eks:TagResource', 'role-denies']]);
    expect(cannotRun(checks)).toEqual([{ role: DEPLOY, ...TAG, verdict: 'role-denies' }]);
  });

  it('on the action role: an action the role allows waits for a grant until a person granted it', () => {
    expect(actionChecks(ACTIONS, [SCALE], [], { allowed: [SCALE], denied: [] })[0]!.verdict).toBe('grant');
    expect(actionChecks(ACTIONS, [SCALE], [granted(ACTIONS)], { allowed: [SCALE], denied: [] })[0]!.verdict).toBe('ready');
    // A grant for another role covers nothing here.
    expect(actionChecks(ACTIONS, [SCALE], [granted(DEPLOY)], { allowed: [SCALE], denied: [] })[0]!.verdict).toBe('grant');
    // A grant does not widen the role: the session policy only narrows.
    expect(actionChecks(ACTIONS, [SCALE], [granted(ACTIONS)], { allowed: [], denied: [SCALE] })[0]!.verdict).toBe('role-denies');
  });

  it('when IAM cannot simulate, an action is unchecked; on the action role it still waits for its grant', () => {
    const problem = { problem: 'IAM answered AccessDenied' };
    expect(actionChecks(DEPLOY, [SCALE], [], problem)).toEqual([{ role: DEPLOY, ...SCALE, verdict: 'unchecked', why: 'IAM answered AccessDenied' }]);
    expect(actionChecks(ACTIONS, [SCALE], [], problem)[0]!.verdict).toBe('grant');
    expect(actionChecks(ACTIONS, [SCALE], [granted(ACTIONS)], problem)[0]!.verdict).toBe('unchecked');
  });

  it('when the role does not exist in its account, no action can run: no grant is asked, and the line names the role (issue #2387)', () => {
    const missing = { noRole: `arn:aws:iam::${ACCOUNT}:role/${ACTION_ROLE}` };
    const checks = actionChecks(ACTIONS, [SCALE], [], missing);
    expect(checks).toEqual([{ role: ACTIONS, ...SCALE, verdict: 'no-role', why: missing.noRole }]);
    expect(cannotRun(checks)).toEqual(checks);
    expect(actionCheckLines('apply', checks)).toEqual([
      `cannot: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${ACTIONS}: the role ${missing.noRole} does not exist (IAM GetRole: NoSuchEntity). An operator makes the role ${ACTION_ROLE} in account ${ACCOUNT} (the deploy guide, "The action role"); until then no session of it can be minted`,
    ]);
    const deploy = actionChecks(DEPLOY, [SCALE], [], { noRole: `arn:aws:iam::${ACCOUNT}:role/deploy` });
    expect(actionCheckLines('write', deploy)).toEqual([
      `cannot: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${DEPLOY}: the role arn:aws:iam::${ACCOUNT}:role/deploy does not exist (IAM GetRole: NoSuchEntity). Ask for a need on a role that account ${ACCOUNT} has`,
    ]);
  });

  it('says plainly what the minted session cannot do, and what to ask for in its place', () => {
    const lines = actionCheckLines('write', [
      ...actionChecks(DEPLOY, [SCALE, TAG], [], { allowed: [SCALE], denied: [TAG] }),
      ...actionChecks(ACTIONS, [SCALE], [], { allowed: [SCALE], denied: [] }),
    ]);
    expect(lines).toEqual([
      `ready: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${DEPLOY}: the role allows it`,
      `cannot: eks:TagResource on ${ARN} as aws-role ${DEPLOY}: the role does not allow it (IAM policy simulation). Ask for write/aws-role/${ACCOUNT}/${ACTION_ROLE} with --action eks:TagResource=${ARN} in its place, and a person grants it once`,
      `waits: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${ACTIONS}: a person grants it on Access requests, AWS actions (asked now)`,
    ]);
    const denied = actionCheckLines('apply', actionChecks(ACTIONS, [TAG], [], { allowed: [], denied: [TAG] }));
    expect(denied).toEqual([`cannot: eks:TagResource on ${ARN} as aws-role ${ACTIONS}: the role does not allow it (IAM policy simulation). An operator adds it to the role ${ACTION_ROLE} (the deploy guide, "The action role"); a grant only narrows what the role allows`]);
    expect(actionCheckLines('write', actionChecks(DEPLOY, [SCALE], [], { problem: 'no read session' })))
      .toEqual([`not checked: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${DEPLOY}: no read session`]);
  });
});
