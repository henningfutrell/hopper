// The action check of a template request (issue #2206, part 2; design.md "Action grants"): a job that asks for the
// template of a change on an aws-role names the AWS actions the change does (`--action <service:Action>=<ARN>`), and the
// hopper says before the template is made which of them the minted session cannot do. An action the role does not allow
// refuses the request (409), with the need to ask for in its place; one on the action role that no grant covers is asked
// of a person now (`askActions`), so the grant waits on Access requests beside the template, not partway through the
// work. The answer's lines go to the job with the template's answer.
import type { OperationProfile } from '../domain/access.ts';
import { actionCheckLines, actionChecks, cannotRun, type ActionSimulator, type Simulated } from '../domain/action-check.ts';
import { actionNeed, actionsOf } from '../domain/action-grants.ts';
import { APPLY_STEP_OFF } from '../domain/infra-plans.ts';
import type { UserStore } from '../domain/ports.ts';
import { askActions, grantsNow } from './action-grants.ts';

/** The check's answer: a no with its HTTP status, or the lines for the job and whether a grant waits for a person. */
export type TemplateActionsAnswer = { no: { status: 400 | 403 | 409; reason: string } } | { lines: string[]; waits: boolean };

/** What the check uses: the user's store (grants, asks), IAM's simulation (absent: none here), and whether infra applies are off. */
export interface TemplateActionsDeps { store: Pick<UserStore, 'settings' | 'events' | 'jobs'>; simulator?: ActionSimulator; appliesOff(): boolean }

const NO_SIMULATOR: Simulated = { problem: 'this hopper runs no IAM policy simulation' };

/** The check of the actions `said` for `needs`, asked by `job`; `why`: its words, for the person who grants. */
export async function checkTemplateActions(o: TemplateActionsDeps, needs: readonly OperationProfile[], said: readonly string[], job: string, why: string | undefined, now: Date): Promise<TemplateActionsAnswer> {
  if (said.length === 0) return { lines: [], waits: false };
  const need = actionNeed(needs, true);
  if (typeof need === 'string' || !need) return { no: { status: 400, reason: typeof need === 'string' ? need : '--action names what one change on an aws-role does' } };
  const role = need.asset.name;
  const actions = actionsOf(said, role);
  if (typeof actions === 'string') return { no: { status: 400, reason: actions } };
  if (o.appliesOff()) return { no: { status: 409, reason: `${APPLY_STEP_OFF}. No action grant is asked for` } };
  const simulated = o.simulator ? await o.simulator.simulate(role, actions) : NO_SIMULATOR;
  const checks = actionChecks(role, actions, grantsNow(o.store, now), simulated);
  const lines = actionCheckLines(need.operation, checks);
  if (cannotRun(checks).length > 0) {
    return { no: { status: 409, reason: `the session the vault mints for ${need.operation} on aws-role ${role} cannot do each action the change needs, so the hopper makes no template for it:\n${lines.join('\n')}` } };
  }
  const asked = checks.filter((c) => c.verdict === 'grant').map(({ action, resource }) => ({ action, resource }));
  if (asked.length === 0) return { lines, waits: false };
  const a = askActions(o.store, job, role, asked, why, now);
  if ('declined' in a) return { no: { status: 403, reason: a.declined } };
  return { lines, waits: 'waiting' in a };
}

/** The check's lines after a template's answer, and the wait for a grant in words. */
export function withActionLines(text: string, check: { lines: string[]; waits: boolean }): string {
  if (check.lines.length === 0) return text;
  const wait = check.waits ? '\nA step that runs a change waits until a person grants each action that waits.' : '';
  return `${text.trimEnd()}\nThe action check, before the template's first step:\n${check.lines.map((l) => `  ${l}`).join('\n')}${wait}`;
}
