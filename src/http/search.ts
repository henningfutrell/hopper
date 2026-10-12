// Search (issue #945, design.md "Search"): one read that finds the user's jobs by their words, filters and facets, a
// small read for type-ahead, the index's state, and Reindex. Every hit is decided by Access (OpenFGA
// `search_hit#can_view`) for the person who asks, so a direct job's hit (issue #901) stays its owner's. The UI, the
// operator CLI and an agent with an API token use these same routes. Solr down: `state` says `degraded` and why; the
// rest of the hopper goes on.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SEARCH_TYPES, type SearchAnswer, type SearchStatus, type SearchType, type SuggestAnswer } from '../domain/search.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import { signedInOf, userIdOf, type TenantParts } from './tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** One value, or many: `?status=a,b` and `?status=a&status=b` read the same. A value holds no comma. */
const list = <T extends string>(max: number, ok: (s: string) => s is T, what: string) => z.union([z.string(), z.array(z.string())]).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (parts.length > max) ctx.addIssue({ code: 'custom', message: `at most ${max}` });
  for (const p of parts) if (!ok(p)) ctx.addIssue({ code: 'custom', message: `${p} is not ${what}` });
  return parts.length > 0 ? parts.filter(ok) : undefined;
});
const matching = (re: RegExp) => (s: string): s is string => re.test(s);
const isType = (s: string): s is SearchType => (SEARCH_TYPES as readonly string[]).includes(s);
/** Labels, apart: a label may hold a comma, so each is its own `?label=`. */
const labels = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(20)]).optional()
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
const instant = z.iso.datetime({ offset: true, error: 'an ISO time, such as 2026-10-01T00:00:00Z' }).optional();

export const searchQuery = z.object({
  q: z.string().max(500).default(''),
  type: list(SEARCH_TYPES.length, isType, `a search type (${SEARCH_TYPES.join(', ')})`),
  status: list(20, matching(/^[a-z_]+$/), 'a job status'),
  label: labels,
  repo: list(20, matching(/^[^/\s,]+\/[^/\s,]+$/), 'owner/name'),
  from: instant, to: instant,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export const suggestQuery = z.object({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export const reindexBody = z.strictObject({});

const ANSWER = '`state` (`ok`, `degraded` — Solr not reached, or Access not asked: `why` says which; the hits Access did not decide are left out — or `not-configured`: no HOPPER_SOLR_URL)';

export const SEARCH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/search', tag: 'Jobs', summary: 'Search the jobs', query: searchQuery, description: `Issue #945: the user's jobs that match \`q\` — words in a job's title, what it was asked, its result, its questions and their answers, why it failed and the failure assessor's verdict, its labels, repository, requester and status; empty: every job —, filtered by \`type\` (\`job\`), \`status\`, \`label\` (each one given must be on it), \`repo\` and the time it was made (\`from\` at or after, \`to\` before). Best match first, then the newest. ${ANSWER}; \`total\`, how many matched; \`hits\`, the page (\`limit\` 1–100, default 20, from \`offset\`), each its \`type\`, \`ref\` (the job's id), \`title\`, \`status\`, \`labels\`, \`repo\`, \`created\`, \`updated\`, \`url\` (its view in the UI) and \`highlights\` (by field, the parts that matched, \`<mark>\` around each match and the rest escaped HTML); \`facets\`, the counts of each \`type\`, \`status\`, \`labels\` and \`repo\` among all that matched. Each hit is decided by Access for the person who asks (OpenFGA \`search_hit#can_view\`): a direct job's is private, seen by its owner only. No secret, vault value or credential is ever in the index. Not cached.`, returns: '`SearchAnswer`', errors: [400] },
  { method: 'get', path: '/api/search/suggest', tag: 'Jobs', summary: 'Search: type-ahead', query: suggestQuery, description: `Issue #945: job titles whose words start with what \`q\` holds (each word typed in full, the last one its start), best first, at most \`limit\` (1–20, default 8). ${ANSWER}; \`suggestions\`, each its \`type\`, \`ref\`, \`title\` and \`url\`, decided by Access as a search's hits are. Not cached.`, returns: '`SuggestAnswer`', errors: [400] },
  { method: 'get', path: '/api/search/status', tag: 'Jobs', summary: 'Search: the index\'s state', description: `Issue #945: ${ANSWER}; \`pending\`, the index updates that wait for Solr; \`backfill\`, when the last one was asked and whether every job it marked is written. Not cached.`, returns: '`SearchStatus`' },
  { method: 'post', path: '/ui/api/search/reindex', tag: 'Jobs', summary: 'Search: build the index again', description: 'Issue #945: every job of the user is marked to be written to the index again, in the background; the index is rebuilt from the database, the source of truth. Answers how many were marked and the state. The hopper does this by itself at the first start that finds no document of the user in the index (a new core, or one whose volume was lost).', role: 'operator', body: reindexBody, returns: '`{ marked: number, status: SearchStatus }`' },
];

/** Who asks: the request's user (the UI session's, the API token's, or loopback's one user). */
const viewerOf = (req: FastifyRequest): string => {
  const id = userIdOf(req);
  if (id === undefined) throw new HttpError(401, 'sign in to search');
  return id;
};

export function searchReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/search', async (req, reply): Promise<SearchAnswer> => {
    const q = parseWith(searchQuery, req.query);
    const t = o.tenant(req);
    reply.header('cache-control', 'no-store');
    return t.search.search(viewerOf(req), {
      text: q.q, limit: q.limit, offset: q.offset,
      ...(q.type ? { types: q.type } : {}), ...(q.status ? { statuses: q.status } : {}),
      ...(q.label ? { labels: q.label } : {}), ...(q.repo ? { repos: q.repo } : {}),
      ...(q.from ? { from: new Date(q.from).toISOString() } : {}), ...(q.to ? { to: new Date(q.to).toISOString() } : {}),
    });
  });
  app.get('/api/search/suggest', async (req, reply): Promise<SuggestAnswer> => {
    const q = parseWith(suggestQuery, req.query);
    const t = o.tenant(req);
    reply.header('cache-control', 'no-store');
    return t.search.suggest(viewerOf(req), q.q, q.limit);
  });
  app.get('/api/search/status', async (req, reply): Promise<SearchStatus> => {
    const t = o.tenant(req);
    reply.header('cache-control', 'no-store');
    return t.search.status();
  });
}

export function registerSearchRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/search/reindex', o.operator, async (req) => {
    parseWith(reindexBody, req.body ?? {});
    if (!signedInOf(req)) throw new HttpError(401, 'sign in to rebuild the index');
    const t = o.tenant(req);
    const marked = t.search.reindex();
    void t.search.pass();
    return { marked, status: t.search.status() };
  });
}
