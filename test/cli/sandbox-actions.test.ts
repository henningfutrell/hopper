// `hopper sandbox actions | grant-action | decline-action | revoke-action` (issue #2206, design.md "Action grants"): the
// calls the operator CLI makes, before any daemon. A job's ask for an AWS action is granted or declined on
// `POST /ui/api/sandbox-requests`, and a grant revoked on `POST /ui/api/sandbox-approvals`, as on Access requests.
import { describe, expect, it } from 'vitest';
import { sandboxCall } from '../../src/cli-operator-vault.ts';

const ROLE = '123456789012/hopper-action';
const ARN = 'arn:aws:eks:us-west-1:123456789012:nodegroup/identity-eks/identity-eks-nodes/*';
const SCOPE = { role: ROLE, action: 'eks:UpdateNodegroupConfig', resource: ARN };

describe('hopper sandbox actions (issue #2206)', () => {
  it('lists the asks, those on run cards first, and the grants', () => {
    const list = sandboxCall(['actions']);
    expect(list).toMatchObject({ role: 'viewer', path: '/api/vault' });
    const onCard = { job: 'j1', ...SCOPE, at: 't' }, loose = { job: 'j2', ...SCOPE, at: 't' }, grant = { ...SCOPE, by: 'a person', at: 't' };
    expect(list.pick!({ runs: [{ jobId: 'j1', actions: [onCard] }, { jobId: 'j3' }], actionAsks: [loose], actionGrants: [grant] })).toEqual({ asks: [onCard, loose], grants: [grant] });
    expect(list.pick!({})).toEqual({ asks: [], grants: [] });
  });

  it('grant-action, decline-action and revoke-action send one decision of the scope', async () => {
    const grant = sandboxCall(['grant-action', 'j1', ROLE, `eks:UpdateNodegroupConfig=${ARN}`]);
    expect(grant).toMatchObject({ role: 'admin', path: '/ui/api/sandbox-requests' });
    expect(await grant.body!(undefined as never)).toEqual({ action: 'grant-action', job: 'j1', grant: SCOPE });
    expect(await sandboxCall(['decline-action', 'j1', ROLE, `eks:UpdateNodegroupConfig=${ARN}`, '--reason', 'use terraform']).body!(undefined as never))
      .toEqual({ action: 'decline-action', job: 'j1', grant: SCOPE, reason: 'use terraform' });
    expect(await sandboxCall(['decline-action', 'j1', ROLE, `eks:UpdateNodegroupConfig=${ARN}`]).body!(undefined as never)).toEqual({ action: 'decline-action', job: 'j1', grant: SCOPE });
    const revoke = sandboxCall(['revoke-action', ROLE, `eks:UpdateNodegroupConfig=${ARN}`]);
    expect(revoke).toMatchObject({ role: 'admin', path: '/ui/api/sandbox-approvals' });
    expect(await revoke.body!(undefined as never)).toEqual({ revokeAction: SCOPE });
  });

  it('refuses a scope with no resource, a missing argument and a reason on a grant, before any call', () => {
    expect(() => sandboxCall(['grant-action', 'j1', ROLE, 'eks:UpdateNodegroupConfig'])).toThrow(/usage: hopper sandbox/);
    expect(() => sandboxCall(['grant-action', 'j1', ROLE])).toThrow(/usage: hopper sandbox/);
    expect(() => sandboxCall(['grant-action', 'j1', ROLE, `eks:UpdateNodegroupConfig=${ARN}`, '--reason', 'x'])).toThrow(/usage: hopper sandbox/);
    expect(() => sandboxCall(['revoke-action', 'j1', ROLE, `eks:UpdateNodegroupConfig=${ARN}`])).toThrow(/usage: hopper sandbox/);
    expect(() => sandboxCall(['actions', 'x'])).toThrow(/usage: hopper sandbox/);
  });
});
