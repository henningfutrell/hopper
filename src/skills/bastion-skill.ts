// The bastion ask (issue #2146, design.md "Bastions"): `sh "$HOPPER_SKILL" bastion --template NAME --targets "…" --why
// "…"`. The job names a template of the user's with an observe on each target's namespace or cluster; its sandbox runs
// of that template are asked for as a sandbox ask's are (`sandbox --template`), and wait for the same approvals. Once
// they are approved and the template is ready, the hopper starts the job's bastion, or answers the one it has.
// `bastion` alone says where the job's bastion stands; `bastion stop` stops it.
import type { Job } from '../domain/types.ts';
import type { SandboxRequestView } from '../domain/sandbox-approvals.ts';
import { templateWait } from '../domain/sandboxes-before-start.ts';
import type { TemplateView } from '../domain/vault.ts';
import { parseTargets, placeTargets, targetText } from '../sandbox/bastion.ts';
import type { Bastions, BastionView } from '../sandbox/bastions.ts';
import type { AskAbout } from './template-request.ts';

export const BASTION_SKILL = 'bastion';

/** What the ask needs of the user: their templates, the job's sandbox runs of one, and their bastions (absent: none start). */
export interface BastionUser {
  template(name: string): TemplateView | undefined;
  sandbox(template: string, job: Job, about?: AskAbout): SandboxRequestView;
  bastions?: Pick<Bastions, 'start' | 'of' | 'stop'>;
}

/** The fields of the ask: `asset` (stop, status), `template`, `targets`, `why`. */
export interface BastionFields { asset?: string; template?: string; targets?: string; why?: string }

/** How the broker answers: a no (recorded), a loaded skill (recorded), a wait, and its words for a request's wait or decline. */
export interface BastionSay<A> {
  no(status: number, reason: string): A;
  loaded(text: string): A;
  waiting(text: string): A;
  waitingText(template: string, r: SandboxRequestView): string;
  declinedText(template: string, r: SandboxRequestView): string;
}

const START = 'sh "$HOPPER_SKILL" bastion --template NAME --targets "<cluster>/<namespace>/<svc|pod|deploy>/<name>:<port> ..." --why "<why the job needs it>"';

/** Where a bastion stands, in words for the job. */
export function bastionText(v: BastionView): string {
  const forwards = v.targets.map((t) => `  ${t.target} on 127.0.0.1:${t.local} in the box`).join('\n');
  if (v.state === 'ended') {
    return `bastion ${v.id} of template ${v.template} ended at ${v.endedAt}: ${v.ended}${v.endedBy ? ` by ${v.endedBy}` : ''}${v.problem ? `: ${v.problem}` : ''}. Ask again for a new one: ${START}\n${v.log ? `Its last output:\n${v.log}\n` : ''}`;
  }
  return `bastion ${v.id} of template ${v.template} is ${v.state} (box ${v.box}). It forwards to:\n${forwards}\n`
    + `Its kube tokens stay in the box, and the hopper renews them. It ends at ${v.expiresAt} unless it is used before, when this job ends, or with: sh "$HOPPER_SKILL" bastion stop.\n`
    + 'Nothing outside the box reaches the forwards yet: the hopper\'s relay, which joins a job to them, comes in a later part of issue #2146.\n';
}

export async function bastionAsk<A>(u: BastionUser, job: Job, f: BastionFields, say: BastionSay<A>): Promise<A> {
  const b = u.bastions;
  if (!b) return say.no(503, 'this hopper starts no bastion');
  if (f.asset === 'stop') {
    const v = b.stop(job.id, 'job');
    return v ? say.loaded(`stopping: ${bastionText(v)}`) : say.no(404, 'this job has no bastion that runs');
  }
  if (f.asset !== undefined && f.asset !== 'status') return say.no(400, `bastion takes stop or status, not ${f.asset}`);
  if (!f.template) {
    const v = b.of(job.id);
    return v ? say.loaded(bastionText(v)) : say.no(404, `this job has no bastion. Start one: ${START}`);
  }
  const targets = parseTargets(f.targets);
  if (typeof targets === 'string') return say.no(400, targets);
  if (!f.why) return say.no(400, `say why the job needs the bastion, for the person who approves it: ${START}`);
  const t = u.template(f.template);
  if (!t) return say.no(404, `there is no template ${f.template}. Ask for one with an observe on each target's namespace: sh "$HOPPER_SKILL" sandbox-template --needs "observe/namespace/<cluster>/<namespace>" --why "…"`);
  const placed = placeTargets(targets, t.profiles);
  if (typeof placed === 'string') return say.no(400, placed);
  const r = u.sandbox(t.name, job, { purpose: f.why, plan: `a bastion that port-forwards to ${targets.map(targetText).join(' ')}` });
  const later = ' Add --wait to have the hopper tell you when the bastion can start.\n';
  if (r.state === 'waiting') return say.waiting(`${say.waitingText(t.name, r)}${later}`);
  if (r.state === 'declined') return say.no(403, say.declinedText(t.name, r));
  const waits = templateWait(t, job.id);
  if (waits) return say.waiting(`waiting: ${waits}.${later}`);
  const v = await b.start(job, t, targets);
  return 'no' in v ? say.no(v.status, v.no) : say.loaded(bastionText(v));
}
