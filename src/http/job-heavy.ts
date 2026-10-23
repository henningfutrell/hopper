// A running job's heavy steps (issue #2622 part 3, design.md "The heavy-step gate"): before a JVM build, an install, a
// browser install or test run or an image build, `hopper-heavy` (src/github-proxy/heavy-script.ts) asks for a slot of its
// host's memory, outside the UI session, on the hopper's own URL and behind the Host guard, like the topology read
// (job-topology.ts). The gate is the user's (src/engine/heavy-gate.ts).
//
//   POST /job/heavy   `Authorization: Bearer <the job's proxy token>`; JSON, by `op`:
//     take     `{ argv }` — the command and its first arguments: `{ slot, renewS }` (run, and renew it), `{ wait, retryS }`
//              (ask again then; why it waits), or `{ light }` (no heavy step, or no memory reading: run, no slot).
//     renew    `{ slot }`: `{ ok }`, false when the slot is not the job's or was let go.
//     release  `{ slot }`: `{ ok }`.
//
// Only while the job is at work: 401 the token is no job's, or its job is not at work; 400 a bad call. It changes no job,
// question, webhook or setting, and records nothing: the slots are kept in memory.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobStatus } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import type { Tenants } from './tenants.ts';

export const JOB_HEAVY_PATH = '/job/heavy';
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;

const slot = z.string().min(1).max(100);
const body = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('take'), argv: z.array(z.string().max(4096)).min(1).max(16) }),
  z.strictObject({ op: z.literal('renew'), slot }),
  z.strictObject({ op: z.literal('release'), slot }),
]);

export function jobHeavyRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  app.post(JOB_HEAVY_PATH, async (req, reply) => {
    const say = (status: number, text: string) => reply.code(status).type('text/plain; charset=utf-8').send(`${text}\n`);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const t = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
    if (!t || !job) return say(401, 'no: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.');
    if (!AT_WORK.includes(job.status)) return say(401, `no: job ${job.id} is ${job.status}, not at work: only a job at work asks for a heavy step.`);
    const b = body.safeParse(req.body ?? {});
    if (!b.success) return say(400, `no: ${b.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    const call = b.data;
    reply.header('cache-control', 'no-store');
    if (call.op === 'take') return reply.send(await t.heavyGate.take(job, call.argv));
    if (call.op === 'renew') return reply.send({ ok: t.heavyGate.renew(job, call.slot) });
    return reply.send({ ok: t.heavyGate.release(job, call.slot) });
  });
}
