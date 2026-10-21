// The action check's simulation (issue #2206, part 2; design.md "Action grants"), at the `ActionSimulator` port: IAM's
// policy simulation (`iam:SimulatePrincipalPolicy`, @aws-sdk/client-iam) of the role a change is minted as, one call per
// action on its resource. It runs with a read session of the account's read role `hopper-read`, minted as topology
// discovery mints one (no job, no template: the read role and the read session policy bound it); `ReadOnlyAccess`
// allows `iam:Simulate*`, and the role must too. First it reads the role (`iam:GetRole`, issue #2387): a role the
// account does not have is said so, as no session of it can be minted; a read IAM refuses goes on to the simulation. The simulation reads the role's own policies only: an organization's
// service control policy or a resource policy can still refuse the call when it runs.
import { GetRoleCommand, IAMClient, NoSuchEntityException, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import type { Asset } from '../domain/access.ts';
import type { ActionSimulator, Simulated } from '../domain/action-check.ts';
import type { AwsAction } from '../domain/action-grants.ts';
import { EKS_READ_ROLE } from '../domain/cluster-discovery.ts';
import type { DiscoveryMintAnswer } from './discovery-mint.ts';

/** What sends one IAM command: an SDK client's `send`. */
export interface IamSender { send(command: unknown): Promise<unknown> }
/** The IAM client's config: the read session, its region, and one endpoint when it is not AWS's. */
export interface IamConfig { region: string; endpoint?: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; maxAttempts: number }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The role's ARN, in the partition of the resource's ARN: `arn:aws:iam::<account>:role/<role>`. */
const roleArnOf = (role: string, resource: string): string => {
  const [account, name] = role.split('/');
  return `arn:${resource.split(':')[1] ?? 'aws'}:iam::${account}:role/${name}`;
};

export function createActionSimulator(o: { mint(asset: Asset): Promise<DiscoveryMintAnswer>; iam?(c: IamConfig): IamSender }): ActionSimulator {
  const iamOf = o.iam ?? ((c: IamConfig): IamSender => new IAMClient(c));
  return {
    async simulate(role, actions): Promise<Simulated> {
      const reader = `${role.split('/')[0]}/${EKS_READ_ROLE}`;
      const m = await o.mint({ kind: 'aws-role', name: reader });
      if ('refused' in m) return { problem: `the vault minted no read session of ${reader} to simulate with: ${m.refused}` };
      if (m.minted.kind !== 'aws' || m.reach.kind !== 'aws') return { problem: `the vault minted no AWS session of ${reader} to simulate with` };
      const s = m.minted;
      const iam = iamOf({
        region: m.reach.region, ...(m.reach.stsEndpoint ? { endpoint: m.reach.stsEndpoint } : {}), maxAttempts: 2,
        credentials: { accessKeyId: s.AccessKeyId, secretAccessKey: s.SecretAccessKey, sessionToken: s.SessionToken },
      });
      const roleArn = roleArnOf(role, actions[0]?.resource ?? '');
      try {
        await iam.send(new GetRoleCommand({ RoleName: role.split('/')[1] }));
      } catch (e) {
        if (e instanceof NoSuchEntityException) return { noRole: roleArn };
      }
      const allowed: AwsAction[] = [], denied: AwsAction[] = [];
      try {
        for (const a of actions) {
          const out = (await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: roleArnOf(role, a.resource), ActionNames: [a.action], ResourceArns: [a.resource] }))) as
            { EvaluationResults?: { EvalDecision?: string }[] };
          const decisions = (out.EvaluationResults ?? []).map((r) => r.EvalDecision);
          (decisions.length > 0 && decisions.every((d) => d === 'allowed') ? allowed : denied).push(a);
        }
      } catch (e) {
        return { problem: `IAM did not simulate the policy (the read role ${EKS_READ_ROLE} needs iam:SimulatePrincipalPolicy): ${messageOf(e)}` };
      }
      return { allowed, denied };
    },
  };
}
