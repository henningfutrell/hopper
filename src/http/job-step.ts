// A running job's sandbox steps: Windows sandbox steps (issue #731, design.md "Windows sandbox steps"), box steps
// (issue #1004, since issue #1349 in a sandbox of their own each, design.md "Box steps"), and need steps (issue #1007, design.md "Need steps"). What `hopper-step` asks, outside the UI session, on the hopper's own URL and
// behind the Host guard, like the skill broker (job-skill.ts).
// `Authorization: Bearer <the job's proxy token>`, honoured only while its job is at work.
//
//   GET  /job/step                     the user's Windows hosts, one per line; then the job's approved sandboxes, `box T  template T`
//   POST /job/step?host=&key=&command=&timeout=&output=...&secret=...[&rerun=1]
//                                      a Windows step: the inputs as the body (a tar, application/x-tar; empty: none).
//                                      Kept in the database and run by its saga (issue #1611): 202 at once, its id in
//                                      `x-hopper-step`; else `no: <reason>`. `key` is the job's for the ask: the same ask
//                                      sent again is the same step. `rerun`: the job says the step is safe to run again,
//                                      so a hopper that stops while it runs runs it again (issue #2117)
//   POST /job/step?box=&key=&command=&timeout=&output=...[&planId=]
//                                      a box step (issue #1349): in a need box of the template the job's approved sandbox
//                                      request names, minted the template's reads, and its changes with `planId`. Kept in
//                                      the database and run by its saga (issue #1568): 202 at once, its id in
//                                      `x-hopper-step`. `key` is the job's for the ask: the same ask sent again is the
//                                      same step
//   POST /job/step?needs=&why=&plan=&planId=&key=&command=&timeout=&output=...[&ready=1]
//                                      a Linux step (issue #1007): the same, in a need box of a ready template that covers
//                                      the needs, its credentials minted for it. No such template yet: it is asked for as
//                                      `sandbox-template` asks (`why`, `plan`), and 202 `waiting: …` while it waits for a
//                                      person or its check; the wait opens a watch that ends the job's own wait (issue #998).
//                                      With `ready`: 200 `ready: …` once a template covers the needs, and no step runs.
//                                      `action=<service:Action>=<ARN>` (issue #2206): an AWS action the one change on
//                                      an aws-role needs; one no action grant covers is asked of a person, and 202
//                                      `waiting: …` until a person grants it
//   GET  /job/step/:id/log?from=N      a step's log from character N; where the next read starts in
//                                      `x-hopper-step-log-next`, and `x-hopper-step-state` running or ended (then the log
//                                      is whole)
//   DELETE /job/step/:id               the job stops its step: its saga is aborted
//   GET  /job/step/:id                 the step's outputs (a tar; empty: none), its exit code in `x-hopper-step-exit`,
//                                      the hopper's problem, if any, in `x-hopper-step-problem`, and a need step's
//                                      outputs' sha256 in `x-hopper-step-outputs-sha256` (issue #2288); 202 while it runs
//
// It changes no job, question, webhook or setting: a step runs on a Windows host the user set up, or in a one-shot need
// box, burned after the step, and is recorded on the job's timeline (`step.started`, `step.finished`, `step.refused`). A
// `secret` the host gives goes to the step, after the job's vault grant; a credential minted
// for a need step goes to its need box only; never in an answer to the job. A template a need step asks for is saved and
// approved only as a template request is (job-skill.ts). Below `approved` (issue #655 part 7), gate 2 gives the job no step
// with no person: a need step is refused, and a box step runs only from a sandbox request a person approved. Sandbox
// strictness (brake 2, issue #655 part 8) does the same for the templates it holds. A need whose minimum trust the job's
// stamp does not meet is refused (issue #655 part 16), and a box step of such a template does not run (`runnable`).
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jobBrake } from '../domain/intake-strictness.ts';
import { actionInWords, actionNeed, actionsOf, type AwsAction } from '../domain/action-grants.ts';
import { APPLY_STEP_OFF } from '../domain/infra-plans.ts';
import { mintKindFor } from '../domain/minting.ts';
import { NEED_STEP_KEY } from '../domain/need-steps.ts';
import { DEFAULT_SANDBOX_STRICTNESS, personBrake, sandboxBrakeText } from '../domain/sandbox-strictness.ts';
import { gate2Min } from '../domain/trust-stamp.ts';
import { MIN_TRUST_DECLINER } from '../domain/stamp-capabilities.ts';
import type { Job, JobStatus, TemplateView } from '../domain/types.ts';
import { STEP_INPUTS_MAX_BYTES } from '../domain/windows-steps.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { NEED_STEP_INPUTS_MAX_BYTES } from '../sandbox/need-steps.ts';
import type { SkillWaits } from '../skills/index.ts';
import { needsOf, TEMPLATE_SKILL } from '../skills/template-request.ts';
import { STEP_HEADER, STEP_PATH, type StepState } from '../windows-steps/index.ts';
import type { TenantParts, Tenants } from './tenants.ts';
import { askActions } from '../vault/action-grants.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;

function askerOf(tenants: Tenants, authorization: string | undefined): { t: TenantParts; job: Job } | { status: number; text: string } {
  const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
  const t = parts ? tenants.user(parts.userId) : undefined;
  const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
  if (!parts || !t || !job) return { status: 401, text: 'the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.' };
  if (!AT_WORK.includes(job.status)) return { status: 401, text: `job ${job.id} is ${job.status}, not at work: only a running job runs a step.` };
  return { t, job };
}

const no = (reply: FastifyReply, status: number, why: string): FastifyReply => reply.code(status).type('text/plain; charset=utf-8').send(`no: ${why}\n`);
const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
const all = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** A header's value: printable ASCII on one line. */
const headerSafe = (s: string): string => s.replace(/[^\x20-\x7e]/g, ' ').slice(0, 500);

/** The body, at most `max` bytes, in memory: a step's inputs, kept in the database (issues #1568, #1611); or why not. */
async function bodyOf(req: FastifyRequest, max: number): Promise<Buffer | string> {
  if (req.body === undefined || req.body === null) {
    const length = req.headers['content-length'];
    return length === undefined || length === '0' ? Buffer.alloc(0) : 'send the inputs as the body, content-type application/x-tar';
  }
  if (typeof (req.body as NodeJS.ReadableStream).pipe !== 'function') return 'send the inputs as the body, content-type application/x-tar';
  const chunks: Buffer[] = [];
  let bytes = 0;
  const into = new Writable({
    write(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > max) { done(new Error(`the inputs may hold at most ${max / (1024 * 1024)} MiB`)); return; }
      chunks.push(chunk);
      done();
    },
  });
  try {
    await pipeline(req.body as NodeJS.ReadableStream, into);
    return Buffer.concat(chunks);
  } catch (e) {
    return (e as Error).message;
  }
}

/** A step's ask kept (issues #1568, #1611): 202 with its id, else `no: <reason>`. */
const asked = (reply: FastifyReply, started: { id: string } | { status: number; no: string }): FastifyReply =>
  ('no' in started ? no(reply, started.status, started.no)
    : reply.code(202).header(STEP_HEADER.id, started.id).type('text/plain; charset=utf-8').send(`started: step ${started.id}\n`));

const ASK_SANDBOX = (needs: string): string => `Ask for a sandbox a person approves: sh "$HOPPER_SKILL" sandbox --needs "${needs}" --why "<why the job needs it>"`;

/**
 * Why gate 2 refuses the job a need step (issue #655 parts 7, 12): its trust stamp is below `approved`, or below the level
 * the intake strictness on it needs now; undefined: it does not.
 */
function belowApproved(t: TenantParts, job: Job, needs: string): string | undefined {
  const brake = jobBrake(t.store.settings.getIntakeStrictness(), job);
  const why = t.store.jobs.gate2Hold(job, brake);
  return why ? `${why}: a need step runs only for a job at ${gate2Min(brake)} or above. ${ASK_SANDBOX(needs)}` : undefined;
}

/** Why brake 2 refuses a need step of `template` (issue #655 part 8): a person approves each of its runs; undefined: it does not. */
function braked(t: TenantParts, template: TemplateView, needs: string): string | undefined {
  const b = personBrake(t.store.settings.getSandboxStrictness() ?? DEFAULT_SANDBOX_STRICTNESS, template);
  return b ? `${sandboxBrakeText(b)}: a person approves each run of the template ${template.name}, and a need step has no approval of its own. ${ASK_SANDBOX(needs)}` : undefined;
}

/**
 * Whether the step waits on an action grant (issue #2206): each action no grant covers is asked of a person once, and
 * 202 says so; one a person declined is a 403. Undefined: every action is granted.
 */
function actionWait(t: TenantParts, job: Job, role: string, actions: readonly AwsAction[], why: string | undefined): { status: number; text: string } | undefined {
  const a = askActions(t.store, job.id, role, actions, why, new Date());
  if ('granted' in a) return undefined;
  if ('declined' in a) return { status: 403, text: `no: ${a.declined}\n` };
  const words = a.waiting.map((x) => actionInWords({ ...x, role })).join('; ');
  return { status: 202, text: `waiting: a person grants ${words}, on Access requests. hopper-step asks again by itself; else end your turn with HOPPER_WAITING (on: vault grant): the hopper ends your wait when it is granted\n` };
}

/** `skillWaits`: a Linux step's template is asked for through them (issue #1007), so a wait for it ends the job's own wait. */
export function jobStepRoutes(app: FastifyInstance, o: { tenants: Tenants; skillWaits: SkillWaits }): void {
  void app.register(async (scope) => {
    // The inputs as a stream: counted as they come, refused past the most a step may send.
    scope.addContentTypeParser('application/x-tar', (_req, payload, done) => { done(null, payload); });

    scope.get(STEP_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const hosts = who.t.windowsSteps.hosts();
      const boxes = who.t.sandboxRequests.runnable(who.job.id);
      const text = (hosts.length === 0
        ? 'The hopper has no Windows host: a person adds one in Settings → Windows hosts.\n'
        : hosts.map((h) => `${h.name}  ${h.workDir}${h.label ? `  ${h.label}` : ''}${h.secrets?.length ? `  secrets: ${h.secrets.join(', ')}` : ''}\n`).join(''))
        + boxes.map((t) => `box ${t}  template ${t}\n`).join('');
      return reply.type('text/plain; charset=utf-8').send(text);
    });

    scope.post(STEP_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const query = (req.query ?? {}) as Record<string, unknown>;
      const needs = one(query.needs);
      if (needs !== undefined) {
        const below = belowApproved(who.t, who.job, needs);
        if (below) return no(reply, 403, below);
        const read = needsOf(needs);
        if (typeof read === 'string') return no(reply, 400, read);
        // Issue #655 part 16: a need above the job's trust is refused by policy before a template is made for it.
        const outside = who.t.sandboxRequests.outside(who.job.id, read);
        if (outside) return no(reply, 403, `${MIN_TRUST_DECLINER} refuses this need step: ${outside}. An admin sets the minimum trust in Users & access → Access. Find another way.`);
        // A need the vault mints nothing for is refused before any template is made for it.
        const unminted = read.find((p) => mintKindFor(p.asset.kind) === undefined);
        if (unminted) return no(reply, 400, `${unminted.operation}/${unminted.asset.kind}/${unminted.asset.name}: the hopper mints a credential for a step for an aws-role, a cluster or a namespace only: name aws-role/<account>/<role>, cluster/<name> or namespace/<cluster>/<ns>`);
        const steps = who.t.needSteps;
        // Issue #2206: the actions the step's one change on an aws-role needs, each granted by a person once.
        const said = all(query.action), need = actionNeed(read, said.length > 0);
        if (typeof need === 'string') return no(reply, 400, need);
        const actions = need ? actionsOf(said, need.asset.name) : [];
        if (typeof actions === 'string') return no(reply, 400, actions);
        if (need && steps.appliesOff()) return no(reply, 409, `${APPLY_STEP_OFF}. No action grant is asked for`);
        const waits = need ? actionWait(who.t, who.job, need.asset.name, actions, one(query.why)) : undefined;
        if (waits && waits.status !== 202) return reply.code(waits.status).type('text/plain; charset=utf-8').send(waits.text);
        let template = steps.covering(read, who.job.id);
        if (!template) {
          // No ready template covers the needs: asked for as a template request is — made once, approved only by a person or
          // a policy —, and its wait opens a watch that ends the job's own wait when the answer is ready (issue #998). Its
          // actions too (issue #2206, part 2): the action check, so the grant and the template wait for a person at once.
          const why = one(query.why), plan = one(query.plan);
          const asked = await o.skillWaits.handle(req.headers.authorization, { name: TEMPLATE_SKILL, needs, ...(why ? { why } : {}), ...(plan ? { plan } : {}), ...(said.length ? { actions: said.join(' ') } : {}) });
          if (asked.status !== 200) return reply.code(asked.status).type('text/plain; charset=utf-8').send(asked.text);
          template = steps.covering(read, who.job.id);
          if (!template) return no(reply, 503, 'the template for these needs is ready, but no need box can run it yet: ask again in a minute');
        }
        if (waits) return reply.code(waits.status).type('text/plain; charset=utf-8').send(waits.text);
        const brake = braked(who.t, template, needs);
        if (brake) return no(reply, 403, brake);
        // `ready`: only whether a template is ready for the needs (hopper-step asks so while it waits), no step run.
        if (one(query.ready) !== undefined) return reply.type('text/plain; charset=utf-8').send(`ready: template ${template.name} covers ${read.length === 1 ? 'the need' : `the ${read.length} needs`}\n`);
        const command = one(query.command), timeout = one(query.timeout), planId = one(query.planId), key = one(query.key);
        if (!key || !NEED_STEP_KEY.test(key)) return no(reply, 400, 'send key: 8 to 64 letters, digits, - or _, the same each time the same step is asked');
        const inputs = await bodyOf(req, NEED_STEP_INPUTS_MAX_BYTES);
        if (typeof inputs === 'string') return no(reply, 400, inputs);
        return asked(reply, steps.start(who.job, {
          template, needs: read, outputs: all(query.output),
          ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(planId !== undefined ? { plan: planId } : {}),
          ...(actions.length ? { actions } : {}),
        }, { key, inputs }));
      }
      const host = one(query.host);
      const box = one(query.box);
      const command = one(query.command);
      const timeout = one(query.timeout);
      if (box !== undefined && host !== undefined) return no(reply, 400, 'name a Windows host or a box, not both');
      if (box !== undefined) {
        // A box step (issue #1349): a sandbox of its own, of the template the job's approved sandbox request names.
        const planId = one(query.planId), key = one(query.key);
        if (!key || !NEED_STEP_KEY.test(key)) return no(reply, 400, 'send key: 8 to 64 letters, digits, - or _, the same each time the same step is asked');
        const inputs = await bodyOf(req, NEED_STEP_INPUTS_MAX_BYTES);
        if (typeof inputs === 'string') return no(reply, 400, inputs);
        return asked(reply, who.t.needSteps.box(who.job, {
          box, approved: who.t.sandboxRequests.runnable(who.job.id), outputs: all(query.output), secrets: all(query.secret),
          ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(planId !== undefined ? { plan: planId } : {}),
        }, { key, inputs }));
      }
      const key = one(query.key);
      if (!key || !NEED_STEP_KEY.test(key)) return no(reply, 400, 'send key: 8 to 64 letters, digits, - or _, the same each time the same step is asked');
      const inputs = await bodyOf(req, STEP_INPUTS_MAX_BYTES);
      if (typeof inputs === 'string') return no(reply, 400, inputs);
      return asked(reply, who.t.windowsSteps.start(who.job, {
        ...(host !== undefined ? { host } : {}), ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), outputs: all(query.output), secrets: all(query.secret),
        ...(one(query.rerun) === '1' ? { rerun: true } : {}),
      }, { key, inputs }));
    });

    scope.get(`${STEP_PATH}/:id/log`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const { id } = req.params as { id: string };
      const from = Number(one((req.query as Record<string, unknown> | undefined)?.from) ?? '0');
      const at = Number.isSafeInteger(from) && from >= 0 ? from : 0;
      const log = who.t.windowsSteps.log(who.job, id, at) ?? who.t.needSteps.log(who.job, id, at);
      if (!log) return no(reply, 404, `no step ${id} of this job's: a step's result is kept for an hour after it ends`);
      return reply.header(STEP_HEADER.logNext, String(log.next)).header(STEP_HEADER.state, log.ended ? 'ended' : 'running')
        .type('text/plain; charset=utf-8').send(log.text);
    });

    scope.delete(`${STEP_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const { id } = req.params as { id: string };
      const stopped = who.t.windowsSteps.stop(who.job, id) ?? who.t.needSteps.stop(who.job, id);
      if (stopped === undefined) return no(reply, 404, `no step ${id} of this job's`);
      return reply.type('text/plain; charset=utf-8').send(stopped ? `stopping: step ${id}\n` : `ended: step ${id}\n`);
    });

    scope.get(`${STEP_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const { id } = req.params as { id: string };
      const step: StepState | undefined = who.t.windowsSteps.state(who.job, id) ?? who.t.needSteps.state(who.job, id);
      if (!step) return no(reply, 404, `no step ${id} of this job's: a step's result is kept for an hour after it ends`);
      if ('running' in step) return reply.code(202).type('text/plain; charset=utf-8').send(`running: step ${id}\n`);
      reply.header(STEP_HEADER.exit, String(step.result.exit)).type('application/x-tar');
      if (step.result.problem) reply.header(STEP_HEADER.problem, headerSafe(step.result.problem));
      if (step.result.outputsSha256) reply.header(STEP_HEADER.sha256, step.result.outputsSha256);
      const outputs = step.outputs ?? Buffer.alloc(0);
      // Its length said (issue #1255): a job whose copy ends short knows it, instead of unpacking part of it.
      return reply.header('content-length', String(outputs.length)).send(outputs);
    });
  });
}
