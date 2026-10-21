// Issue #2206, part 2: the action check asks IAM's policy simulation whether a role allows each action on its resource,
// with a read session of the account's read role `hopper-read`. The IAM client is a fake sender here.
import { describe, expect, it } from 'vitest';
import { GetRoleCommand, NoSuchEntityException } from '@aws-sdk/client-iam';
import type { Asset } from '../../src/domain/access.ts';
import { createActionSimulator } from '../../src/vault/action-simulation.ts';

const ACCOUNT = '167028478405';
const ARN = `arn:aws:eks:us-west-1:${ACCOUNT}:nodegroup/identity-eks/identity-eks-nodes/*`;
const SCALE = { action: 'eks:UpdateNodegroupConfig', resource: ARN };
const TAG = { action: 'eks:TagResource', resource: ARN };
const SESSION = { kind: 'aws' as const, AccessKeyId: 'AKIAREAD', SecretAccessKey: 'read', SessionToken: 'token', Expiration: '2026-10-20T12:00:00Z' };

function harness(decide: (input: Record<string, unknown>) => string | Error, refused?: string, getRole: () => Error | undefined = () => undefined) {
  const minted: Asset[] = [], sent: Record<string, unknown>[] = [], roles: Record<string, unknown>[] = [], configs: unknown[] = [];
  const simulator = createActionSimulator({
    async mint(asset) {
      minted.push(asset);
      return refused ? { refused } : { minted: SESSION, reach: { kind: 'aws', region: 'us-west-1', stsEndpoint: 'http://127.0.0.1:9/sts' }, credential: 'aws-minting' };
    },
    iam(config) {
      configs.push(config);
      return {
        async send(command: unknown) {
          const input = (command as { input: Record<string, unknown> }).input;
          if (command instanceof GetRoleCommand) {
            roles.push(input);
            const e = getRole();
            if (e) throw e;
            return { Role: { RoleName: input.RoleName, Arn: `arn:aws:iam::${ACCOUNT}:role/${String(input.RoleName)}` } };
          }
          sent.push(input);
          const d = decide(input);
          if (d instanceof Error) throw d;
          return { EvaluationResults: [{ EvalActionName: (input.ActionNames as string[])[0], EvalDecision: d }] };
        },
      };
    },
  });
  return { simulator, minted, sent, roles, configs };
}

describe('the action simulation (issue #2206, part 2)', () => {
  it('asks IAM once per action, for the role, on its resource, with the read session of hopper-read', async () => {
    const h = harness((i) => ((i.ActionNames as string[])[0] === SCALE.action ? 'allowed' : 'implicitDeny'));
    expect(await h.simulator.simulate(`${ACCOUNT}/hopper-action`, [SCALE, TAG])).toEqual({ allowed: [SCALE], denied: [TAG] });
    expect(h.minted).toEqual([{ kind: 'aws-role', name: `${ACCOUNT}/hopper-read` }]);
    expect(h.roles).toEqual([{ RoleName: 'hopper-action' }]);
    expect(h.sent).toEqual([
      { PolicySourceArn: `arn:aws:iam::${ACCOUNT}:role/hopper-action`, ActionNames: [SCALE.action], ResourceArns: [ARN] },
      { PolicySourceArn: `arn:aws:iam::${ACCOUNT}:role/hopper-action`, ActionNames: [TAG.action], ResourceArns: [ARN] },
    ]);
    expect(h.configs[0]).toMatchObject({ region: 'us-west-1', endpoint: 'http://127.0.0.1:9/sts', credentials: { accessKeyId: 'AKIAREAD', sessionToken: 'token' } });
  });

  it('an explicit deny is denied too', async () => {
    const h = harness(() => 'explicitDeny');
    expect(await h.simulator.simulate(`${ACCOUNT}/deploy`, [SCALE])).toEqual({ allowed: [], denied: [SCALE] });
  });

  it('says why when there is no read session, or IAM refuses the simulation', async () => {
    expect(await harness(() => 'allowed', 'no minting credential for account 167028478405').simulator.simulate(`${ACCOUNT}/deploy`, [SCALE]))
      .toEqual({ problem: `the vault minted no read session of ${ACCOUNT}/hopper-read to simulate with: no minting credential for account 167028478405` });
    const refused = await harness(() => new Error('User is not authorized to perform: iam:SimulatePrincipalPolicy')).simulator.simulate(`${ACCOUNT}/deploy`, [SCALE]);
    expect(refused).toEqual({ problem: 'IAM did not simulate the policy (the read role hopper-read needs iam:SimulatePrincipalPolicy): User is not authorized to perform: iam:SimulatePrincipalPolicy' });
  });

  it('says the role does not exist when IAM answers NoSuchEntity, and simulates nothing (issue #2387)', async () => {
    const h = harness(() => 'allowed', undefined, () => new NoSuchEntityException({ message: 'The role with name hopper-action cannot be found.', $metadata: {} }));
    expect(await h.simulator.simulate(`${ACCOUNT}/hopper-action`, [SCALE])).toEqual({ noRole: `arn:aws:iam::${ACCOUNT}:role/hopper-action` });
    expect(h.sent).toEqual([]);
  });

  it('simulates still when the read role may not read the role (GetRole refused)', async () => {
    const h = harness(() => 'allowed', undefined, () => new Error('User is not authorized to perform: iam:GetRole'));
    expect(await h.simulator.simulate(`${ACCOUNT}/deploy`, [SCALE])).toEqual({ allowed: [SCALE], denied: [] });
  });
});
