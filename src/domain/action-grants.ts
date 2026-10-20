// Action grants (issue #2206, design.md "Action grants"): a need step's AWS change needs an action the roles it may use
// do not allow. The job names the action and its resource (`--action eks:UpdateNodegroupConfig=<ARN>`); a person grants
// exactly that once, for that role, and a later ask of the same role, action and resource is covered until the time limit
// of remembered write approvals ends (issue #1001). The step's session is then minted under a session policy that allows
// the reads of `ReadOnlyAccess` and the granted actions on their resources only: a session policy only narrows what the
// role may do, so the role must allow the action. The **action role** `hopper-action` is the role an operator makes for
// this: wide in IAM, and minted by the hopper only so narrowed. Pure.
import type { Asset, OperationProfile } from './access.ts';
import { AWS_READ_POLICY } from './minting.ts';

/** The role an operator makes for granted actions: a change on it is minted only with `--action`, so only narrowed. */
export const ACTION_ROLE = 'hopper-action';
/** The most actions one step names. */
export const ACTIONS_MAX = 10;
/** The most characters of inline session policy STS takes. */
export const SESSION_POLICY_MAX = 2048;

/** One AWS action on one resource, as IAM names them: `eks:UpdateNodegroupConfig` on an ARN. */
export interface AwsAction { action: string; resource: string }

/** A person's grant of one action on one resource for an aws-role (`<account>/<role>`). Kept in the user's settings (key `actionGrants`). */
export interface ActionGrant extends AwsAction { role: string; by: string; at: string }
/** A grant as the vault's view shows it: when it ends; absent, it is kept until it is revoked. */
export interface ActionGrantView extends ActionGrant { expiresAt?: string }

/** A job's ask for an action no grant covers yet, kept in memory while the job is at work. */
export interface ActionAsk extends AwsAction { role: string; job: string; at: string; why?: string }
/** An ask as the vault's view shows it: its job's title and its issue or pull request. */
export interface ActionAskView extends ActionAsk { jobTitle?: string; jobUrl?: string }

/** `service:Action`, as IAM names an action; no wildcard: a person grants one action. */
const ACTION = /^[a-z0-9-]{2,40}:[A-Za-z][A-Za-z0-9]{0,127}$/;
/** An ARN: its partition, service, region (no wildcard), account (empty or 12 digits) and resource. */
const ARN = /^arn:aws(?:-[a-z]+)*:([a-z0-9-]{1,40}):([a-z0-9-]{0,30}):(\d{12})?:([\x21-\x7e]{1,1000})$/;

const same = (a: AwsAction & { role: string }, b: AwsAction & { role: string }): boolean =>
  a.role === b.role && a.action === b.action && a.resource === b.resource;

/**
 * The actions `said` names, each `<service:Action>=<resource ARN>`, for the aws-role `role` (`<account>/<role>`); or why
 * not. A resource that names an account names the role's own.
 */
export function actionsOf(said: readonly string[], role: string): AwsAction[] | string {
  if (said.length > ACTIONS_MAX) return `name at most ${ACTIONS_MAX} actions in one step`;
  const account = role.split('/')[0];
  const out: AwsAction[] = [];
  for (const s of said) {
    const at = s.indexOf('=');
    const action = at < 0 ? s : s.slice(0, at), resource = at < 0 ? '' : s.slice(at + 1);
    if (!ACTION.test(action)) return `${s}: name the action as IAM does, <service>:<Action> with no wildcard (eks:UpdateNodegroupConfig), then = and its resource's ARN`;
    const arn = ARN.exec(resource);
    if (!arn) return `${s}: name the resource the action changes by its ARN (arn:aws:eks:us-west-1:123456789012:nodegroup/<cluster>/<group>/*)`;
    if (arn[3] && arn[3] !== account) return `${s}: the resource is in account ${arn[3]}, not in the account of aws-role ${role}`;
    if (!out.some((a) => a.action === action && a.resource === resource)) out.push({ action, resource });
  }
  return out;
}

/**
 * The one need the actions are for: the step's only change on an aws-role; or why the step is refused. A change on the
 * action role with no action is refused too: the hopper mints it only narrowed to granted actions.
 */
export function actionNeed(needs: readonly OperationProfile[], actions: readonly AwsAction[]): OperationProfile | undefined | string {
  const changes = needs.filter((p) => p.asset.kind === 'aws-role' && p.operation !== 'read');
  const bare = changes.find((p) => p.asset.name.split('/')[1] === ACTION_ROLE);
  if (actions.length === 0) return bare ? `${bare.operation}/aws-role/${bare.asset.name}: the hopper mints a change on ${ACTION_ROLE} only for the actions a person granted: name each with --action <service:Action>=<resource ARN>` : undefined;
  if (changes.length !== 1) return '--action names what one change on an aws-role does: name exactly one write, sync or apply need on an aws-role with it';
  return changes[0];
}

const endOf = (g: ActionGrant, hours: number): Date | undefined => (hours > 0 ? new Date(new Date(g.at).getTime() + hours * 3_600_000) : undefined);

/** The grants not ended at `now`, each with its end. The time limit is the one of remembered write approvals. */
export function liveGrants(list: readonly ActionGrant[], hours: number, now: Date): ActionGrantView[] {
  return list.flatMap((g) => {
    const end = endOf(g, hours);
    if (end && end.getTime() <= now.getTime()) return [];
    return [end ? { ...g, expiresAt: end.toISOString() } : { ...g }];
  });
}

/** The list after a person granted `g` (in place of one for the same role, action and resource). Ended ones go. */
export function granting(list: readonly ActionGrant[], g: ActionGrant, now: Date, hours: number): ActionGrant[] {
  const kept = liveGrants(list, hours, now).map(({ expiresAt: _end, ...k }) => k);
  return [...kept.filter((k) => !same(k, g)), g];
}

/** The list without the grant for that role, action and resource. */
export const revoking = (list: readonly ActionGrant[], g: AwsAction & { role: string }): ActionGrant[] => list.filter((k) => !same(k, g));

/** The actions of `role` that no live grant covers. */
export const ungranted = (live: readonly ActionGrant[], role: string, actions: readonly AwsAction[]): AwsAction[] =>
  actions.filter((a) => !live.some((g) => same(g, { ...a, role })));

/**
 * The session policies of a step's change on `roleArn` narrowed to granted `actions`: `ReadOnlyAccess`, and an inline
 * policy that allows each action on its resource and denies assuming any other role; or why STS would refuse it.
 */
export function actionSession(roleArn: string, actions: readonly AwsAction[]): { policyArns: string[]; policy: string } | string {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      ...actions.map((a, i) => ({ Sid: `HopperGranted${i}`, Effect: 'Allow', Action: a.action, Resource: a.resource })),
      { Sid: 'HopperGrantedNoOtherRole', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:AssumeRoleWithSAML', 'sts:AssumeRoleWithWebIdentity'], NotResource: roleArn },
    ],
  });
  if (policy.length > SESSION_POLICY_MAX) return `the session policy for these actions is ${policy.length} characters, more than the ${SESSION_POLICY_MAX} STS takes: name fewer actions in one step`;
  return { policyArns: [AWS_READ_POLICY], policy };
}

/** An action in words, for a card and a refusal: `eks:UpdateNodegroupConfig on <ARN> as aws-role <account>/<role>`. */
export const actionInWords = (a: AwsAction & { role: string }): string => `${a.action} on ${a.resource} as aws-role ${a.role}`;

/** The aws-role asset of a grant's role. */
export const roleAsset = (role: string): Asset => ({ kind: 'aws-role', name: role });
