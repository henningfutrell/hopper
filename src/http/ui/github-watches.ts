// GitHub watches (issue #427, design.md "GitHub watches"): the interval each watch polls on, and every watch of a pointed
// job that has not ended with its last poll. The interval is the user's, in the database, changed by an admin; it applies
// at once, with no restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GITHUB_WATCH_INTERVAL } from '../../domain/github-watch.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const githubWatchBody = z.strictObject({ intervalSeconds: z.number().int().min(GITHUB_WATCH_INTERVAL.min).max(GITHUB_WATCH_INTERVAL.max) });

export const GITHUB_WATCH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/github-watches', tag: 'Jobs', summary: 'GitHub watches', description: 'Issue #427: how often each GitHub watch polls (`settings.intervalSeconds`, default 60), and the watch of each pointed job that has not ended: its `repo` and `pointer`, its last `snapshot` (state, labels, comments, reviews, linked pull requests), `polledAt`, `changedAt`, and `error` when the last poll failed. A change seen is `github_watch.changed`. Not cached.', returns: '`GitHubWatchView`' },
  { method: 'post', path: '/ui/api/github-watches', tag: 'Jobs', summary: 'Change how often GitHub watches poll', description: `Issue #427: \`intervalSeconds\`, ${GITHUB_WATCH_INTERVAL.min} to ${GITHUB_WATCH_INTERVAL.max}. Saved for the user (\`github_watch.settings_changed\`) and applied at once: the watches poll now and then on the new interval, with no restart. The same value changes nothing.`, role: 'admin', body: githubWatchBody, returns: '`GitHubWatchView`', errors: [400] },
];

export function githubWatchReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/github-watches', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).githubProxy.watches.view();
  });
}

export function registerGitHubWatchRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/github-watches', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the GitHub watches');
    const b = parseWith(githubWatchBody, req.body);
    return o.tenant(req).githubProxy.watches.change(b, identityName(s.identity));
  });
}
