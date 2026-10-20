// Direct queries (issue #2184, design.md "Direct queries"): a caller asks the hopper a question straight — through an API
// token or the UI session, with no GitHub issue — and its job answers it by looking only. The caller names its own
// request id, so a request sent again answers the query kept, and the webhook subscription its callback goes to: the
// subscription's URL and signing secret are a person's, set through the UI session, never the caller's. A question that
// asks for a change is refused: a change goes through a direct job or an issue. Least role: operator. A box action: it
// starts a job. The caller reads the query back by its request id, and cancels its job as any job.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const requestParams = z.object({ requestId: z.string() });
const word = z.string().trim().min(1).max(200);

/** Why a question that asks for a change is refused (issue #2184). */
export const CHANGE_REFUSED = 'a direct query only looks: it changes no code, infrastructure or secret. Submit a direct job (POST /ui/api/direct-jobs) or file an issue for a change';

export const directQueryBody = z.strictObject({
  requestId: z.string().trim().min(1, 'give the request an id').max(200),
  question: z.string().trim().min(1, 'ask a question').max(16_000),
  callback: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['look', 'change']).default('look'),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200)).max(20).default([]),
  clusters: z.array(word).max(20).default([]),
  labels: z.array(word).max(20).default([]),
  executor: z.string().min(1).max(200).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

const VIEW = '`DirectQuery`: a `DirectJob` (see `GET /api/direct-jobs/:id`; its `brief` is the question) with `query` (`requestId`, `callback`, `repos`, `clusters`) and `state`: `accepted` (no job at work yet), `running`, `waiting` (on a question or its own wait: answer it in Questions), `answered` (`job.result` is the answer), `failed` (`job.error` says why), `cancelled`';

export const DIRECT_QUERY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/direct-queries', tag: 'Jobs', summary: 'Direct queries', description: 'Issue #2184: every question a caller asked the hopper straight, newest first, each with its newest job and where it stands. Not cached.', returns: `\`{ directQueries: DirectQuery[] }\`; ${VIEW}` },
  { method: 'get', path: '/api/direct-queries/:requestId', tag: 'Jobs', summary: 'One direct query', description: 'Issue #2184: the direct query by the caller\'s request id: how a caller polls it. Cancel its job with `POST /ui/api/jobs/:id/cancel`.', returns: VIEW, errors: [404] },
  { method: 'post', path: '/ui/api/direct-queries', tag: 'Jobs', summary: 'Ask a direct query', description: 'Issue #2184: a question with no GitHub issue, answered by a job that only looks. `requestId` (the caller\'s own id: the same id again answers the query kept, `replayed: true`, and makes nothing; with another question or callback, 409), `question`, `callback` (the name of a webhook subscription: `direct_query.accepted`, `.answered`, `.failed` and `.cancelled` are delivered to it, signed with its secret, kept and retried as every delivery; 400 when no active subscription has that name), `mode` (`look`, the default; `change` is refused, 422: submit a direct job or file an issue), `repos` and `clusters` (where to look first: hints, they allow nothing), `labels` (routing labels beside `direct:query`), `executor`, `priority`. Its job is queued at once from the job source `direct`, with no vault grant and no repository; the GitHub proxy and the git proxy refuse its writes and its pushes. A box action: an API token needs to be a box token.', role: 'operator', body: directQueryBody, errors: [400, 409, 422], returns: `\`{ directQuery: DirectQuery, job?: Job, replayed?: true }\`; ${VIEW}` },
];

export function directQueryReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/direct-queries', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { directQueries: o.tenant(req).directJobs.queries() };
  });
  app.get('/api/direct-queries/:requestId', async (req, reply) => {
    const { requestId } = parseWith(requestParams, req.params);
    const q = o.tenant(req).directJobs.query(requestId);
    if (!q) throw new HttpError(404, `direct query ${requestId} not found`);
    reply.header('cache-control', 'no-store');
    return q;
  });
}

export function registerDirectQueryRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/direct-queries', o.operator, async (req) => {
    const b = parseWith(directQueryBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to ask a direct query');
    if (b.mode === 'change') throw new HttpError(422, CHANGE_REFUSED);
    const t = o.tenant(req);
    if (b.callback && !t.store.webhooks.list().some((w) => w.active && w.name === b.callback)) {
      throw new HttpError(400, `no active webhook subscription is named ${b.callback}: a person adds it in Settings → Webhooks`);
    }
    const r = t.directJobs.ask({
      requestId: b.requestId, question: b.question, repos: b.repos, clusters: b.clusters, labels: b.labels,
      ...(b.callback ? { callback: b.callback } : {}), ...(b.executor ? { executor: b.executor } : {}), ...(b.priority !== undefined ? { priority: b.priority } : {}),
    }, actingOf(s));
    if ('conflict' in r) throw new HttpError(409, r.conflict);
    return r;
  });
}
