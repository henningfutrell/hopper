// The GitHub proxy's route (issue #563, design.md "GitHub through the hopper"): a running job — not a person —
// asks the hopper for a GitHub operation, outside the UI session, on the hopper's own URL and behind the Host
// guard, like a machine's join and dial-in (client-link.ts).
//
//   POST /job/github   `Authorization: Bearer <the job's proxy token>`; the request as a form (what `hopper-gh`
//                      sends, src/github-proxy/script.ts) or JSON. The hopper does it with its own GitHub
//                      connection, or answers why not. It changes no job, question, webhook or setting.
//
// The hopper acts with its oldest user's GitHub connection — the instance's first, as the plugin store reads
// the oldest user's (src/users/runtimes.ts).
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../domain/ports.ts';
import { createGitHubProxy, createProxyLimiter, PROXY_PATH } from '../github-proxy/index.ts';
import type { Tenants } from './tenants.ts';

export function jobGitHubRoutes(app: FastifyInstance, o: { tenants: Tenants; clock: Clock }): void {
  const proxy = createGitHubProxy({
    user: (id) => o.tenants.user(id)?.githubProxy.user,
    hopper: () => {
      const oldest = o.tenants.list()[0];
      const parts = oldest ? o.tenants.user(oldest.id) : undefined;
      return parts ? { user: parts.githubProxy.user, connection: parts.githubProxy.connection } : undefined;
    },
    limiter: createProxyLimiter(o.clock),
    log: (line) => console.warn(line),
  });
  void app.register(async (scope) => {
    // What curl's --data-urlencode sends; only on this route.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post(PROXY_PATH, async (req, reply) => {
      const answer = await proxy.handle(req.headers.authorization, req.body);
      return reply.code(answer.status).send(answer.body);
    });
  });
}
