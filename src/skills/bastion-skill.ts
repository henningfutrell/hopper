// The bastion ask (issue #2146, design.md "Bastions"): `sh "$HOPPER_SKILL" bastion --template NAME --targets "…" --why
// "…"`. The job names a template of the user's with an observe on each target's namespace or cluster; its sandbox runs
// of that template are asked for as a sandbox ask's are (`sandbox --template`), and wait for the same approvals. Once
// they are approved and the template is ready, the hopper starts the job's bastion, or answers the one it has.
// `bastion` alone says where the job's bastion stands, and how `hopper-relay` reaches a target (part 2); `bastion stop`
// stops it. Part 3: each target must be one the template names as a bastion target, approved with it. Part 6: `--secrets`
// names vault secrets the bastion's box holds, and `bastion read --targets T --path P [--secrets S] [--data JSON]` runs one
// HTTP read of a target in the box with one of them: a Grafana Viewer token stays there, and the job gets the answer.
import type { Job } from '../domain/types.ts';
import type { SandboxRequestView } from '../domain/sandbox-approvals.ts';
import { templateWait } from '../domain/sandboxes-before-start.ts';
import type { TemplateView } from '../domain/vault.ts';
import { parseTargets, placeTargets, targetsOutside, targetText } from '../sandbox/bastion.ts';
import { parseRead } from '../sandbox/bastion-read.ts';
import type { Bastions, BastionView } from '../sandbox/bastions.ts';
import type { AskAbout } from './template-request.ts';

export const BASTION_SKILL = 'bastion';

/** What the ask needs of the user: their templates, the job's sandbox runs of one, and their bastions (absent: none start). */
export interface BastionUser {
  template(name: string): TemplateView | undefined;
  sandbox(template: string, job: Job, about?: AskAbout): SandboxRequestView;
  bastions?: Pick<Bastions, 'start' | 'of' | 'stop' | 'read'>;
}

/** The fields of the ask: `asset` (stop, status, read), `template`, `targets`, `why`; `secrets`, `path` and `data` (part 6). */
export interface BastionFields { asset?: string; template?: string; targets?: string; why?: string; secrets?: string; path?: string; data?: string }

/** How the broker answers: a no (recorded), a loaded skill (recorded), a wait, and its words for a request's wait or decline. */
export interface BastionSay<A> {
  no(status: number, reason: string): A;
  loaded(text: string): A;
  waiting(text: string): A;
  waitingText(template: string, r: SandboxRequestView): string;
  declinedText(template: string, r: SandboxRequestView): string;
}

const START = 'sh "$HOPPER_SKILL" bastion --template NAME --targets "<cluster>/<namespace>/<svc|pod|deploy>/<name>:<port> ..." [--secrets "<vault secret> ..."] --why "<why the job needs it>"';
const READ = 'sh "$HOPPER_SKILL" bastion read --targets TARGET --path "/api/..." [--secrets SECRET] [--data JSON]';

/** Where a bastion stands, in words for the job. */
export function bastionText(v: BastionView): string {
  // Issue #2413: each forward says whether it listens, and the running bastion its output too.
  const state = (t: BastionView['targets'][number]): string => (t.listening ? 'listening' : t.listening === false ? `not listening: ${t.said}` : 'not listening yet');
  const forwards = v.targets.map((t) => `  ${t.target} on 127.0.0.1:${t.local} in the box: ${state(t)}`).join('\n');
  if (v.state === 'ended') {
    return `bastion ${v.id} of template ${v.template} ended at ${v.endedAt}: ${v.ended}${v.endedBy ? ` by ${v.endedBy}` : ''}${v.problem ? `: ${v.problem}` : ''}. Ask again for a new one: ${START}\n${v.log ? `Its last output:\n${v.log}\n` : ''}`;
  }
  return `bastion ${v.id} of template ${v.template} is ${v.state} (box ${v.box}). It forwards to:\n${forwards}\n`
    + `Its kube tokens stay in the box, and the hopper renews them. It ends at ${v.expiresAt} unless it is used before, when this job ends, or with: sh "$HOPPER_SKILL" bastion stop.\n`
    + `Reach a target from here through the hopper's relay: a local port joined to it while a command runs, for example\n`
    + `  sh "$HOPPER_RELAY" ${v.targets[0]?.target ?? 'TARGET'} -- sh -c 'curl -s "http://127.0.0.1:$HOPPER_RELAY_PORT/"'\n`
    + 'Or hold a port of your choice until you stop it: sh "$HOPPER_RELAY" TARGET 19090 &\n'
    + (v.secrets?.length ? `It holds the vault secrets ${v.secrets.join(', ')} for reads in the box (a Grafana token): ${READ}\n` : '')
    + (v.log ? `Its last output:\n${v.log}\n` : '');
}

export async function bastionAsk<A>(u: BastionUser, job: Job, f: BastionFields, say: BastionSay<A>): Promise<A> {
  const b = u.bastions;
  if (!b) return say.no(503, 'this hopper starts no bastion');
  if (f.asset === 'stop') {
    const v = b.stop(job.id, 'job');
    return v ? say.loaded(`stopping: ${bastionText(v)}`) : say.no(404, 'this job has no bastion that runs');
  }
  if (f.asset === 'read') {
    const r = parseRead({ target: f.targets?.trim(), path: f.path, secret: f.secrets?.trim() || undefined, data: f.data });
    if (typeof r === 'string') return say.no(400, `${r}: ${READ}`);
    const a = await b.read(job.id, r);
    if ('no' in a) return say.no(a.status, a.no);
    const body = a.body.toString();
    if (a.status < 200 || a.status > 299) return say.no(502, `${r.target} answered ${a.status}: ${body.slice(0, 1000)}`);
    return say.loaded(body);
  }
  if (f.asset !== undefined && f.asset !== 'status') return say.no(400, `bastion takes stop, status or read, not ${f.asset}`);
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
  const outside = targetsOutside(t, targets);
  if (outside?.why === 'unnamed') {
    const needs = placed.observes.map((p) => `${p.operation}/${p.asset.kind}/${p.asset.name}`).join(' ');
    return say.no(400, `${outside.no}. Ask for one: sh "$HOPPER_SKILL" sandbox-template --needs "${needs}" --targets "${targets.map(targetText).join(' ')}" --why "…"`);
  }
  const r = u.sandbox(t.name, job, { purpose: f.why, plan: `a bastion that port-forwards to ${targets.map(targetText).join(' ')}` });
  const later = ' Add --wait to have the hopper tell you when the bastion can start.\n';
  if (r.state === 'waiting') return say.waiting(`${say.waitingText(t.name, r)}${later}`);
  if (r.state === 'declined') return say.no(403, say.declinedText(t.name, r));
  const waits = templateWait(t, job.id);
  if (waits) return say.waiting(`waiting: ${waits}.${later}`);
  if (outside) return say.waiting(`waiting: ${outside.no}.${later}`);
  const secrets = (f.secrets ?? '').split(/\s+/).filter((s) => s !== '');
  const v = await b.start(job, t, targets, secrets);
  return 'no' in v ? say.no(v.status, v.no) : say.loaded(bastionText(v));
}
