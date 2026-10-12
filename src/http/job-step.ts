// A running job's Windows sandbox steps (issue #731, design.md "Windows sandbox steps"): what `hopper-step` asks, outside
// the UI session, on the hopper's own URL and behind the Host guard, like the skill broker (job-skill.ts).
// `Authorization: Bearer <the job's proxy token>`, honoured only while its job is at work.
//
//   GET  /job/step                     the user's Windows hosts, one per line
//   POST /job/step?host=&command=&timeout=&output=...
//                                      the inputs as the body (a tar, application/x-tar; empty: none). 200: the step's
//                                      output, streamed as it comes, its id in `x-hopper-step`; else `no: <reason>`
//   GET  /job/step/:id                 the step's outputs (a tar; empty: none), its exit code in `x-hopper-step-exit`,
//                                      and the hopper's problem, if any, in `x-hopper-step-problem`
//
// It changes no job, question, webhook or setting: a step runs on a Windows host the user set up, and is recorded on the
// job's timeline (`step.started`, `step.finished`, `step.refused`).
import { createReadStream, createWriteStream } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Job, JobStatus } from '../domain/types.ts';
import { STEP_INPUTS_MAX_BYTES } from '../domain/windows-steps.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
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

export function jobStepRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  void app.register(async (scope) => {
    // The inputs as a stream: kept to a file as they come, never whole in memory.
    scope.addContentTypeParser('application/x-tar', (_req, payload, done) => { done(null, payload); });

    scope.get(STEP_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const hosts = who.t.windowsSteps.hosts();
      const text = hosts.length === 0
        ? 'The hopper has no Windows host: a person adds one in Settings → Windows hosts.\n'
        : hosts.map((h) => `${h.name}  ${h.workDir}${h.label ? `  ${h.label}` : ''}\n`).join('');
      return reply.type('text/plain; charset=utf-8').send(text);
    });

    scope.post(STEP_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const query = (req.query ?? {}) as Record<string, unknown>;
      const host = one(query.host);
      const command = one(query.command);
      const timeout = one(query.timeout);
      const start = who.t.windowsSteps.start(who.job, {
        ...(host !== undefined ? { host } : {}), ...(command !== undefined ? { command } : {}), ...(timeout !== undefined ? { timeout } : {}), outputs: all(query.output),
      });
      if ('no' in start) return no(reply, start.status, start.no);
      const kept = await keep(req, start.inputsFile, STEP_INPUTS_MAX_BYTES);
      if (typeof kept === 'string') { start.drop(kept); return no(reply, 400, kept); }
      // The step's output streams to the job as it comes; the job's request gone stops the step.
      const out = new PassThrough();
      const gone = new AbortController();
      let ended = false;
      reply.raw.on('close', () => { if (!ended) gone.abort(); });
      void start.run({ inputsBytes: kept, log: (chunk) => { out.write(chunk); }, signal: gone.signal })
        .finally(() => { ended = true; out.end(); });
      return reply.header(STEP_HEADER.id, start.id).type('text/plain; charset=utf-8').send(out);
    });

    scope.get(`${STEP_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(reply, who.status, who.text);
      const { id } = req.params as { id: string };
      const r = who.t.windowsSteps.result(who.job, id);
      if (!r) return no(reply, 404, `no step ${id} of this job's: a step's result is kept for an hour after it ends`);
      reply.header(STEP_HEADER.exit, String(r.result.exit)).type('application/x-tar');
      if (r.result.problem) reply.header(STEP_HEADER.problem, headerSafe(r.result.problem));
      return r.outputs ? reply.send(createReadStream(r.outputs)) : reply.send(Buffer.alloc(0));
    });
  });
}
