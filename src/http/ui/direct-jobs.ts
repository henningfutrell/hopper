// Direct jobs (issue #901, design.md "Direct jobs"): a person submits a job straight to the hopper — a title, a brief,
// routing labels and what they authorize — through the UI session, a box token or the operator CLI, with no GitHub
// issue. Its job is queued at once from the `direct` job source. The reads answer each submission with its job's status,
// result and open questions, so an agent that submitted one reads its result back. Least role: operator. A box action:
// it starts a job. The authorization `vault` is the submitter's vault grant for the job's item: Access decides it first,
// as for Grant on Vault (OpenFGA `vault_grant#can_grant`); refused or not asked, nothing is kept.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { ACCESS_UNAVAILABLE } from '../../domain/access.ts';
import { authorizesVault, directKey } from '../../domain/direct-jobs.ts';
import { DIRECT_QUERY_OPERATIONS, directQueryReadRoutes, registerDirectQueryRoutes } from './direct-queries.ts';

export { DIRECT_QUERY_OPERATIONS };
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const idParams = z.object({ id: z.string() });
const word = z.string().trim().min(1).max(200);

export const directJobBody = z.strictObject({
  title: z.string().trim().min(1, 'give it a title').max(300),
  brief: z.string().trim().min(1, 'say what to do').max(64_000),
  labels: z.array(word).max(50).default([]),
  authorizations: z.array(word).max(50).default([]),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200).optional(),
  executor: z.string().min(1).max(200).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  promoteWhenDone: z.boolean().optional(),
});

const VIEW = '`DirectJob`: `id`, `title`, `brief`, `labels`, `authorizations`, `repo`, `executor`, `priority`, `promoteWhenDone`, `submittedBy` (`person`, `via`: ui, api or cli), `submittedAt`, `artifacts` (its job\'s, private in the hopper: `id`, `title`, `summary`, `kind`, `revision`, `url`), `promotion` (its live promotion to GitHub: `repo`, `kind`, `number`, `url`, `artifacts` as linked, `promotedBy`, `promotedAt`, `updatedAt`, `stale`: the artifacts changed since), `offer` (`asked` or `suggested`: its job finished and it is not promoted), and `job` once it has one: `id`, `status`, `result`, `error`, `finishedAt`, `questions` (its open questions: `id`, `text`, `tier`, `askedAt`; answer one with `POST /ui/api/questions/:id/answer`)';

export const DIRECT_JOB_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/direct-jobs', tag: 'Jobs', summary: 'Direct jobs', description: 'Issue #901: every job a person submitted straight to the hopper, newest first, each with its newest job as it stands now. Not cached.', returns: `\`{ directJobs: DirectJob[] }\`; ${VIEW}` },
  { method: 'get', path: '/api/direct-jobs/:id', tag: 'Jobs', summary: 'One direct job', description: 'Issue #901: the direct job and its newest job: its status, its result once it ended, its error, its open questions. How a requester reads the result back.', returns: VIEW, errors: [404] },
  { method: 'post', path: '/ui/api/direct-jobs', tag: 'Jobs', summary: 'Submit a direct job', description: 'Issue #901: a job with no GitHub issue. `title`, `brief` (what to do), routing `labels` (the routing rules match them, as an issue\'s), `authorizations` (what the submitter authorizes it to do or reach; `vault` grants its item the vault — Access decides it first, OpenFGA `vault_grant#can_grant`, 403 refused, 503 not asked, and nothing is kept —, `vault.granted`), `repo` (`owner/name`, the one repository its work may open a pull request on; absent: none), `executor` (default `herdr-claude`), `priority` (0–100, default 50), `promoteWhenDone` (issue #946: offer its promotion to GitHub once it finished; nothing is posted without a person\'s confirmed preview). The brief and the results stay in the hopper: nothing goes to GitHub unless its work opens a pull request on `repo`. Its job is queued at once, from the job source `direct`, and waits at the queue gate as any job. `direct_job.submitted` records who submitted it and what they authorized. A box action: an API token needs to be a box token.', role: 'operator', body: directJobBody, errors: [400, 403, 503], returns: `\`{ directJob: DirectJob, job?: Job }\`; ${VIEW}` },
];

/** The direct jobs' reads (issue #901), beside the other `/api/` reads. */
export function directJobReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  directQueryReadRoutes(app, o);
  app.get('/api/direct-jobs', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { directJobs: o.tenant(req).directJobs.list() };
  });
  app.get('/api/direct-jobs/:id', async (req, reply) => {
    const { id } = parseWith(idParams, req.params);
    const d = o.tenant(req).directJobs.get(id);
    if (!d) throw new HttpError(404, `direct job ${id} not found`);
    reply.header('cache-control', 'no-store');
    return d;
  });
}

export function registerDirectJobRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideVaultGrant'> }): void {
  registerDirectQueryRoutes(app, o);
  app.post('/ui/api/direct-jobs', o.operator, async (req) => {
    const b = parseWith(directJobBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to submit a direct job');
    // The id is fixed first, so Access decides the grant for the item the job will have.
    const id = randomUUID();
    if (authorizesVault(b)) {
      const d = await o.access.decideVaultGrant(s.userId, { ownerId: s.userId, key: directKey(id) });
      if (!d.allowed && d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      if (!d.allowed) throw new HttpError(403, `the authorization vault is refused: ${d.reason}`);
    }
    return o.tenant(req).directJobs.submit({
      title: b.title, brief: b.brief, labels: b.labels, authorizations: b.authorizations,
      ...(b.repo ? { repo: b.repo } : {}), ...(b.executor ? { executor: b.executor } : {}), ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.promoteWhenDone ? { promoteWhenDone: true } : {}),
    }, actingOf(s), id);
  });
}
