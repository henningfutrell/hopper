// A running job parks and picks up its user's proposals and research reports (issue #2167, design.md "Parking a proposal or
// a research report"), outside the UI session, on the hopper's own URL and behind the Host guard, like the topology read
// (job-topology.ts). It reaches the same park a person's Park button does, through the `park` skill.
//
//   GET  /job/park    `Authorization: Bearer <the job's proxy token>`. The user's open proposals and research reports,
//                     parked or not, as JSON: `{ items: [{ kind, id, jobId, status, stage, title?, parked? }] }`.
//   POST /job/park    The same token; JSON `{ act: 'park' | 'pick-up', item: <the proposal's or report's id>, reason? }`.
//                     Plain text back: `ok: …`, or `no: <reason>`.
//
// Only while the job is at work: 401 the token is no job's, or its job is not at work; 400 a bad call; 404 no such open
// item. A job parks only an item whose job waits on it, never a running job and never itself, and picks up only an item a
// job parked: a person's park stays until a person picks it up (409). Who did it is kept as `job <its id>`, `via` `job`,
// on the job and in `job.parked` / `job.unparked`. It decides nothing on the item: a decision stays a person's.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PARK_REASON_MAX, parkingJobName } from '../domain/park-ask.ts';
import { parkedItemOf, REVIEW_KINDS, REVIEW_OPEN_STATUSES, REVIEW_SECTIONS, type JobStatus, type ReviewItem } from '../domain/types.ts';
import { EngineError } from '../engine/errors.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import type { TenantParts, Tenants } from './tenants.ts';

export const JOB_PARK_PATH = '/job/park';
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
const body = z.object({
  act: z.enum(['park', 'pick-up']),
  item: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(PARK_REASON_MAX, `reason must be at most ${PARK_REASON_MAX} characters`).optional(),
}).strict();

type Caller = { t: TenantParts; jobId: string } | { refused: string };

function callerOf(o: { tenants: Tenants }, req: FastifyRequest): Caller {
  const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const t = parts ? o.tenants.user(parts.userId) : undefined;
  const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
  if (!t || !job) return { refused: 'the token is not a job\'s of this hopper. A job calls with its own HOPPER_TOKEN_FILE.' };
  if (!AT_WORK.includes(job.status)) return { refused: `job ${job.id} is ${job.status}, not at work: only a job at work parks an item.` };
  return { t, jobId: job.id };
}

/** The open item of that id, of either kind. */
const openItem = (t: TenantParts, id: string): ReviewItem | undefined =>
  REVIEW_KINDS.map((k) => t.store.reviews[k].get(id)).find((p) => p !== undefined && REVIEW_OPEN_STATUSES.includes(p.status));

export function jobParkRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  app.get(JOB_PARK_PATH, async (req, reply) => {
    const c = callerOf(o, req);
    if ('refused' in c) return reply.code(401).type('text/plain; charset=utf-8').send(`no: ${c.refused}\n`);
    const items = REVIEW_KINDS.flatMap((k) => c.t.store.reviews[k].list({ status: [...REVIEW_OPEN_STATUSES], order: 'oldest-first' })).map((p) => {
      const parked = parkedItemOf(c.t.store.jobs.get(p.jobId), p);
      return { kind: p.kind, id: p.id, jobId: p.jobId, status: p.status, stage: p.stage, ...(p.source?.title ? { title: p.source.title } : {}), ...(parked ? { parked } : {}) };
    });
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.post(JOB_PARK_PATH, async (req, reply) => {
    const say = (status: number, text: string) => reply.code(status).type('text/plain; charset=utf-8').send(`${text}\n`);
    const c = callerOf(o, req);
    if ('refused' in c) return say(401, `no: ${c.refused}`);
    const b = body.safeParse(req.body ?? {});
    if (!b.success) return say(400, `no: ${b.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    const { act, item: id, reason } = b.data;
    const item = openItem(c.t, id);
    if (!item) return say(404, `no: no open proposal or research report ${id}. List them: GET ${JOB_PARK_PATH}`);
    const job = c.t.store.jobs.get(item.jobId);
    const noun = REVIEW_SECTIONS[item.kind].noun;
    if (!job || job.id === c.jobId) return say(409, `no: ${noun} ${id} is this job's own: a job does not park itself`);
    const who = { by: parkingJobName(c.jobId), via: 'job' as const };
    const parked = parkedItemOf(job, item);
    try {
      if (act === 'park') {
        if (parked) return say(409, `no: ${noun} ${id} is parked already, since ${parked.at}`);
        if (job.status !== 'waiting_answer' || job[REVIEW_SECTIONS[item.kind].jobField] !== item.id) {
          return say(409, `no: job ${job.id} is ${job.status}, not waiting on ${noun} ${id}: a job parks only an item its job waits on`);
        }
        c.t.engine.park(job.id, { ...who, ...(reason ? { reason } : {}) });
        return say(200, `ok: ${noun} ${id} is parked; its job ${job.id} keeps its work`);
      }
      if (!parked) return say(409, `no: ${noun} ${id} is not parked`);
      if (parked.via !== 'job') return say(409, `no: a person parked it${parked.by ? ` (${parked.by})` : ''}: only a person picks it up`);
      c.t.engine.requeue(job.id, { who });
      return say(200, `ok: ${noun} ${id} is picked up; its job ${job.id} waits on it again`);
    } catch (e) {
      if (e instanceof EngineError) return say(e.code === 'not_found' ? 404 : 409, `no: ${e.message}`);
      throw e;
    }
  });
}
