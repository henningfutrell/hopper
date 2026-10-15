// A job's checkpoint, read back as it resumes elsewhere (issue #921, design.md "Checkpoints and resume elsewhere"): the
// restore command in the job's new pane gets its checkpoint's parts, outside the UI session, on the hopper's own URL and
// behind the Host guard, like the job stream (job-stream.ts).
//
//   GET /job/checkpoint/patch      `Authorization: Bearer <the job's proxy token>`. The patch, as git applies it.
//   GET /job/checkpoint/session    the agent session's file.
//
// Only the job's own, only while it runs resuming elsewhere (`parked.elsewhere` set): 401 the token is no job's, or its job
// ended; 409 the job is not running to resume elsewhere now; 404 no such part. It changes nothing and records nothing.
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { CHECKPOINT_PARTS, TERMINAL_STATUSES, type CheckpointPart } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import type { Tenants } from './tenants.ts';

/** Unpacked in zlib's thread pool, not on the event loop (issue #1154). */
const unpack = promisify(gunzip);

export const CHECKPOINT_PATH = '/job/checkpoint';
const BEARER = /^Bearer\s+(\S+)$/i;

export function jobCheckpointRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  app.get(`${CHECKPOINT_PATH}/:part`, async (req, reply) => {
    const no = (status: number, text: string) => reply.code(status).type('text/plain; charset=utf-8').send(`no: ${text}\n`);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const user = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && user?.githubProxy.user.holds(parts) ? user.githubProxy.user.job(parts.jobId) : undefined;
    if (!parts || !user || !job || TERMINAL_STATUSES.includes(job.status)) return no(401, 'the token is not a running job\'s of this hopper');
    const part = (req.params as { part: string }).part as CheckpointPart;
    if (!CHECKPOINT_PARTS.includes(part)) return no(404, `a checkpoint has no part ${part}: ${CHECKPOINT_PARTS.join(', ')}`);
    if (!job.parked?.elsewhere || job.status !== 'running') return no(409, `job ${job.id} is not resuming elsewhere now: its checkpoint is read only as it starts there`);
    const k = user.store.checkpoints.get(job.id);
    const gz = k && (part === 'patch' ? k.patch : k.session);
    if (!gz) return no(404, `job ${job.id}'s checkpoint holds no ${part}`);
    return reply.code(200).type('application/octet-stream').header('cache-control', 'no-store').send(await unpack(gz));
  });
}
