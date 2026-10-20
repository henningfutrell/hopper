// The action check (issue #2206, part 2; design.md "Action grants"): before a job's template is made, the hopper says
// which AWS actions its change names that the minted session cannot do, so a missing permission shows when the job asks
// for its template, not partway through its work. A change on an aws-role is minted as the role itself, or, on the
// action role, narrowed to the granted actions: so an action is ready when the role allows it (IAM's policy
// simulation) and, on the action role, a person granted it. Pure: the simulation is a port (`ActionSimulator`).
import type { Operation } from './access.ts';
import { ACTION_ROLE, actionInWords, ungranted, type ActionGrant, type AwsAction } from './action-grants.ts';

/** What IAM's policy simulation said of a role's actions: each allowed or denied; or why it could not say. */
export type Simulated = { allowed: AwsAction[]; denied: AwsAction[] } | { problem: string };

/** Asks IAM whether the aws-role `role` (`<account>/<role>`) allows each action on its resource (a port: the AWS SDK in production, a fake in tests). */
export interface ActionSimulator { simulate(role: string, actions: readonly AwsAction[]): Promise<Simulated> }

/**
 * One action's verdict: `ready` (the minted session can do it), `grant` (on the action role, it waits for a person's
 * grant), `role-denies` (the role does not allow it: no grant helps), `unchecked` (IAM could not simulate it, `why`).
 */
export type ActionVerdict = 'ready' | 'grant' | 'role-denies' | 'unchecked';
export interface ActionCheck extends AwsAction { role: string; verdict: ActionVerdict; why?: string }

const isIn = (list: readonly AwsAction[], a: AwsAction): boolean => list.some((x) => x.action === a.action && x.resource === a.resource);

/** Each action's verdict for `role`, from the live grants and the simulation. */
export function actionChecks(role: string, actions: readonly AwsAction[], live: readonly ActionGrant[], simulated: Simulated): ActionCheck[] {
  const onActionRole = role.split('/')[1] === ACTION_ROLE;
  return actions.map((a): ActionCheck => {
    const base = { role, ...a };
    if (!('problem' in simulated) && isIn(simulated.denied, a)) return { ...base, verdict: 'role-denies' };
    if (onActionRole && ungranted(live, role, [a]).length > 0) return { ...base, verdict: 'grant' };
    if ('problem' in simulated) return { ...base, verdict: 'unchecked', why: simulated.problem };
    return { ...base, verdict: 'ready' };
  });
}

/** The actions the role does not allow: the check refuses the template request for them. */
export const roleDenies = (checks: readonly ActionCheck[]): ActionCheck[] => checks.filter((c) => c.verdict === 'role-denies');

/** The check in words, one line per action; `operation`: the change's, for the need to ask for in place of a denied one. */
export function actionCheckLines(operation: Operation, checks: readonly ActionCheck[]): string[] {
  return checks.map((c) => {
    const words = actionInWords(c);
    if (c.verdict === 'ready') return `ready: ${words}: ${c.role.split('/')[1] === ACTION_ROLE ? 'a person granted it' : 'the role allows it'}`;
    if (c.verdict === 'grant') return `waits: ${words}: a person grants it on Access requests, AWS actions (asked now)`;
    if (c.verdict === 'unchecked') return `not checked: ${words}: ${c.why ?? 'IAM did not answer'}`;
    if (c.role.split('/')[1] === ACTION_ROLE) {
      return `cannot: ${words}: the role does not allow it (IAM policy simulation). An operator adds it to the role ${ACTION_ROLE} (the deploy guide, "The action role"); a grant only narrows what the role allows`;
    }
    return `cannot: ${words}: the role does not allow it (IAM policy simulation). Ask for ${operation}/aws-role/${c.role.split('/')[0]}/${ACTION_ROLE} with --action ${c.action}=${c.resource} in its place, and a person grants it once`;
  });
}
