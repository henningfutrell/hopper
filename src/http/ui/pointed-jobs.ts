// Pointed jobs (issue #425, design.md "Pointed jobs"): a person makes a pointed job on an issue or a pull request of a
// GitHub repository, reads and lists them, and moves one along the allowed transitions — each move one event, an illegal
// one refused (409) with nothing recorded. The jobs the hopper already has show in the list as pointed jobs, their status
// read from the job; they are never moved here. A record only: nothing runs a pointed job yet. Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canMove, POINTED_JOB_STATUSES, pointedJobOf, POINTER_KINDS, TRANSITIONS, type PointedJob } from '../../domain/pointed-jobs.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const idParams = z.object({ id: z.string() });

export const pointedJobBody = z.strictObject({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200),
  pointer: z.strictObject({ kind: z.enum(POINTER_KINDS), number: z.number().int().min(1), url: z.url({ protocol: /^https?$/ }).max(500) }),
  directive: z.string().trim().min(1, 'say what to do').max(20_000),
  lane: z.string().min(1).max(200).optional(),
});
export const transitionBody = z.strictObject({ to: z.enum(POINTED_JOB_STATUSES), lane: z.string().min(1).max(200).optional() });

const VIEW = '`PointedJob`: `id`, `repo`, `pointer` (`kind` issue or pull_request, `number`, `url`), `directive`, `lane`, `status`, `source`, `jobId` (a job the hopper already has), `createdAt`, `updatedAt`';

export const POINTED_JOB_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/pointed-jobs', tag: 'Jobs', summary: 'Pointed jobs', description: `Issue #425: every pointed job, newest first: those made through the API, and each job the hopper already has whose item names a repository and an issue, as a pointed job on that issue (\`jobId\`). Such a job's status is read from it: queued or held → \`queued\`, at work → \`running\`, its pull request open → \`awaiting_review\`, merged or finished done → \`merged\`, failed, cancelled, rejected or its pull request closed → \`abandoned\`. Not cached.`, returns: `\`{ pointedJobs: PointedJob[] }\`; ${VIEW}` },
  { method: 'get', path: '/api/pointed-jobs/:id', tag: 'Jobs', summary: 'One pointed job', description: 'Issue #425: the pointed job, or the job of that id as a pointed job.', returns: VIEW, errors: [404] },
  { method: 'post', path: '/ui/api/pointed-jobs', tag: 'Jobs', summary: 'Make a pointed job', description: 'Issue #425: a pointed job on an issue or a pull request of `repo` (owned or not), with the `directive`: what to do there. It starts `queued`, `source: api`. `pointed_job.created`. A record only: nothing runs it yet.', role: 'operator', body: pointedJobBody, returns: VIEW },
  { method: 'post', path: '/ui/api/pointed-jobs/:id/transition', tag: 'Jobs', summary: 'Move a pointed job', description: `Issue #425: moves its status to \`to\`, along the allowed transitions only: ${Object.entries(TRANSITIONS).map(([f, t]) => `${f} → ${t.length ? t.join(' | ') : 'none'}`).join('; ')}. \`lane\`: the lane that works it, kept while running and dropped when it leaves running. \`pointed_job.status_changed\`. 409: a transition that is not allowed, or a job the hopper already has (its status follows its job); nothing is recorded.`, role: 'operator', body: transitionBody, returns: VIEW, errors: [404, 409] },
];

/** The pointed jobs and the jobs read as pointed jobs, newest first. */
const listOf = (t: TenantParts): PointedJob[] => [...t.store.pointedJobs.list(), ...t.store.jobs.list().flatMap((j) => pointedJobOf(j) ?? [])]
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const find = (t: TenantParts, id: string): PointedJob | undefined => {
  const job = t.store.jobs.get(id);
  return t.store.pointedJobs.get(id) ?? (job ? pointedJobOf(job) : undefined);
};

/** The pointed jobs' reads (issue #425), beside the other `/api/` reads. */
export function pointedJobReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/pointed-jobs', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { pointedJobs: listOf(o.tenant(req)) };
  });
  app.get('/api/pointed-jobs/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const p = find(o.tenant(req), id);
    if (!p) throw new HttpError(404, `pointed job ${id} not found`);
    return p;
  });
}

const byOf = (req: FastifyRequest, doing: string): string => {
  const s = signedInOf(req);
  if (!s) throw new HttpError(401, `sign in to ${doing}`);
  return personOf(s);
};

export function registerPointedJobRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/pointed-jobs', o.operator, async (req) => {
    const b = parseWith(pointedJobBody, req.body);
    const by = byOf(req, 'make a pointed job');
    const { store } = o.tenant(req);
    const at = new Date().toISOString();
    return store.tx(() => {
      const p = store.pointedJobs.add({ repo: b.repo, pointer: b.pointer, directive: b.directive, ...(b.lane ? { lane: b.lane } : {}), status: 'queued', source: 'api', createdAt: at, updatedAt: at });
      store.events.append({ type: 'pointed_job.created', data: { id: p.id, repo: p.repo, pointer: p.pointer, source: p.source, by } });
      return p;
    });
  });

  app.post('/ui/api/pointed-jobs/:id/transition', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { to, lane } = parseWith(transitionBody, req.body);
    const by = byOf(req, 'move a pointed job');
    const t = o.tenant(req);
    return t.store.tx(() => {
      const cur = t.store.pointedJobs.get(id);
      if (!cur) {
        if (find(t, id)) throw new HttpError(409, `pointed job ${id} is a job of the hopper: its status follows its job`);
        throw new HttpError(404, `pointed job ${id} not found`);
      }
      if (!canMove(cur.status, to)) throw new HttpError(409, `a pointed job that is ${cur.status} cannot move to ${to}`);
      const { lane: _, ...rest } = cur;
      const kept = to === 'running' ? lane ?? cur.lane : undefined;
      const next = t.store.pointedJobs.put({ ...rest, ...(kept ? { lane: kept } : {}), status: to, updatedAt: new Date().toISOString() });
      t.store.events.append({ type: 'pointed_job.status_changed', data: { id, from: cur.status, to, ...(kept ? { lane: kept } : {}), by } });
      return next;
    });
  });
}
