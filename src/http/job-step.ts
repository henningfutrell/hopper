// A running job's sandbox steps: Windows sandbox steps (issue #731, design.md "Windows sandbox steps"), box steps
// (issue #1004, since issue #1349 in a sandbox of their own each, design.md "Box steps"), and need steps (issue #1007, design.md "Need steps"). What `hopper-step` asks, outside the UI session, on the hopper's own URL and
// behind the Host guard, like the skill broker (job-skill.ts).
// `Authorization: Bearer <the job's proxy token>`, honoured only while its job is at work.
//
//   GET  /job/step                     the user's Windows hosts, one per line; then the job's approved sandboxes, `box T  template T`
//   POST /job/step?host=&command=&timeout=&output=...&secret=...
//                                      the inputs as the body (a tar, application/x-tar; empty: none). 200: the step's
//                                      output, streamed as it comes, its id in `x-hopper-step`; else `no: <reason>`
//   POST /job/step?box=&command=&timeout=&output=...[&planId=]
//                                      a box step (issue #1349): the same, in a need box of the template the job's approved
//                                      sandbox request names, minted the template's reads, and its changes with `planId`
//   POST /job/step?needs=&why=&plan=&planId=&command=&timeout=&output=...[&ready=1]
//                                      a Linux step (issue #1007): the same, in a need box of a ready template that covers
//                                      the needs, its credentials minted for it. No such template yet: it is asked for as
//                                      `sandbox-template` asks (`why`, `plan`), and 202 `waiting: …` while it waits for a
//                                      person or its check; the wait opens a watch that ends the job's own wait (issue #998).
//                                      With `ready`: 200 `ready: …` once a template covers the needs, and no step runs
//   GET  /job/step/:id                 the step's outputs (a tar; empty: none), its exit code in `x-hopper-step-exit`,
//                                      and the hopper's problem, if any, in `x-hopper-step-problem`
//
// It changes no job, question, webhook or setting: a step runs on a Windows host the user set up, or in a one-shot need
// box, burned after the step, and is recorded on the job's timeline (`step.started`, `step.finished`, `step.refused`). A
// `secret` the host gives goes to the step, after the job's vault grant; a credential minted
// for a need step goes to its need box only; never in an answer to the job. A template a need step asks for is saved and
// approved only as a template request is (job-skill.ts).
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mintKindFor } from '../domain/minting.ts';
import type { Job, JobStatus } from '../domain/types.ts';
import { STEP_INPUTS_MAX_BYTES } from '../domain/windows-steps.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { NEED_STEP_INPUTS_MAX_BYTES } from '../sandbox/need-steps.ts';
import type { SkillWaits } from '../skills/index.ts';
import { needsOf, TEMPLATE_SKILL } from '../skills/template-request.ts';
import type { StepStart } from '../windows-steps/service.ts';
import { STEP_HEADER, STEP_PATH } from '../windows-steps/index.ts';
import type { TenantParts, Tenants } from './tenants.ts';

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

/** The body, at most `max` bytes, into `file`; its size, or why not. */
async function keep(req: FastifyRequest, file: string, max: number): Promise<number | string> {
  if (req.body === undefined || req.body === null) {
    // No body at all: no inputs.
    const length = req.headers['content-length'];
    return length === undefined || length === '0' ? 0 : 'send the inputs as the body, content-type application/x-tar';
  }
  if (typeof (req.body as NodeJS.ReadableStream).pipe !== 'function') return 'send the inputs as the body, content-type application/x-tar';
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > max ? new Error(`the inputs may hold at most ${max / (1024 * 1024)} MiB`) : null, chunk);
    },
  });
  try {
    await pipeline(req.body as NodeJS.ReadableStream, count, createWriteStream(file, { mode: 0o600 }));
    return bytes;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Runs a step that was started: the inputs kept, then its output streamed to the job as it comes. */
async function runStarted(req: FastifyRequest, reply: FastifyReply, start: StepStart, max: number): Promise<FastifyReply> {
  const kept = await keep(req, start.inputsFile, max);
  if (typeof kept === 'string') { start.drop(kept); return no(reply, 400, kept); }
  // The step's output streams to the job as it comes; the job's request gone stops the step.
  const out = new PassThrough();
  const gone = new AbortController();
  let ended = false;
  reply.raw.on('close', () => { if (!ended) gone.abort(); });
  void start.run({ inputsBytes: kept, log: (chunk) => { out.write(chunk); }, signal: gone.signal })
    .finally(() => { ended = true; out.end(); });
  return reply.header(STEP_HEADER.id, start.id).type('text/plain; charset=utf-8').send(out);
}

/** The templates of the job's approved sandbox requests: the boxes its box steps may name (issue #1349). */
const approvedSandboxes = (t: TenantParts, job: Job): string[] =>
  t.sandboxRequests.list().filter((r) => r.jobId === job.id && r.state === 'approved').map((r) => r.template);

/** `skillWaits`: a Linux step's template is asked for through them (issue #1007), so a wait for it ends the job's own wait. */
export function jobStepRoutes(app: FastifyInstance, o: { tenants: Tenants; skillWaits: SkillWaits }): void {
  void app.register(async (scope) => {
    // The inputs as a stream: kept to a file as they come, never whole in memory.
    scope.addContentTypeParser('application/x-tar', (_req, payload, done) => { done(null, payload); });

    scope.get(STEP_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const hosts = who.t.windowsSteps.hosts();
      const boxes = approvedSandboxes(who.t, who.job);
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
        const read = needsOf(needs);
        if (typeof read === 'string') return no(reply, 400, read);
        // A need the vault mints nothing for is refused before any template is made for it.
        const unminted = read.find((p) => mintKindFor(p.asset.kind) === undefined);
        if (unminted) return no(reply, 400, `${unminted.operation}/${unminted.asset.kind}/${unminted.asset.name}: the hopper mints a credential for a step for an aws-role, a cluster or a namespace only: name aws-role/<account>/<role>, cluster/<name> or namespace/<cluster>/<ns>`);
        const steps = who.t.needSteps;
        let template = steps.covering(read);
        if (!template) {
          // No ready template covers the needs: asked for as a template request is — made once, approved only by a person or
          // a policy —, and its wait opens a watch that ends the job's own wait when the answer is ready (issue #998).
          const why = one(query.why), plan = one(query.plan);
          const asked = await o.skillWaits.handle(req.headers.authorization, { name: TEMPLATE_SKILL, needs, ...(why ? { why } : {}), ...(plan ? { plan } : {}) });
          if (asked.status !== 200) return reply.code(asked.status).type('text/plain; charset=utf-8').send(asked.text);
          template = steps.covering(read);
          if (!template) return no(reply, 503, 'the template for these needs is ready, but no need box can run it yet: ask again in a minute');
        }
        // `ready`: only whether a template is ready for the needs (hopper-step asks so while it waits), no step run.
        if (one(query.ready) !== undefined) return reply.type('text/plain; charset=utf-8').send(`ready: template ${template.name} covers ${read.length === 1 ? 'the need' : `the ${read.length} needs`}\n`);
        const command = one(query.command), timeout = one(query.timeout), planId = one(query.planId);
        const started = await steps.start(who.job, {
          template, needs: read, outputs: all(query.output),
          ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(planId !== undefined ? { plan: planId } : {}),
        });
        if ('no' in started) return no(reply, started.status, started.no);
        return runStarted(req, reply, started, NEED_STEP_INPUTS_MAX_BYTES);
      }
      const host = one(query.host);
      const box = one(query.box);
      const command = one(query.command);
      const timeout = one(query.timeout);
      if (box !== undefined && host !== undefined) return no(reply, 400, 'name a Windows host or a box, not both');
      if (box !== undefined) {
        // A box step (issue #1349): a sandbox of its own, of the template the job's approved sandbox request names.
        const planId = one(query.planId);
        const started = await who.t.needSteps.box(who.job, {
          box, approved: approvedSandboxes(who.t, who.job), outputs: all(query.output), secrets: all(query.secret),
          ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(planId !== undefined ? { plan: planId } : {}),
        });
        if ('no' in started) return no(reply, started.status, started.no);
        return runStarted(req, reply, started, NEED_STEP_INPUTS_MAX_BYTES);
      }
      const start = await who.t.windowsSteps.start(who.job, {
        ...(host !== undefined ? { host } : {}), ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), outputs: all(query.output), secrets: all(query.secret),
      });
      if ('no' in start) return no(reply, start.status, start.no);
      return runStarted(req, reply, start, STEP_INPUTS_MAX_BYTES);
    });

    scope.get(`${STEP_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const { id } = req.params as { id: string };
      const r = who.t.windowsSteps.result(who.job, id) ?? who.t.needSteps.result(who.job, id);
      if (!r) return no(reply, 404, `no step ${id} of this job's: a step's result is kept for an hour after it ends`);
      reply.header(STEP_HEADER.exit, String(r.result.exit)).type('application/x-tar');
      if (r.result.problem) reply.header(STEP_HEADER.problem, headerSafe(r.result.problem));
      if (!r.outputs) return reply.send(Buffer.alloc(0));
      // Its length said (issue #1255): a job whose copy ends short knows it, instead of unpacking part of it.
      return reply.header('content-length', String(statSync(r.outputs).size)).send(createReadStream(r.outputs));
    });
  });
}
