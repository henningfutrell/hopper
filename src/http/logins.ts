// Login routes (issue #476, design.md "Logins"): the logins a job or run waits on, with the server's time for
// their countdowns. A login's URL and code go only to a UI session of the user (`x-hopper-session`) whose role may
// act on it, operator or admin (issue #477): never to a viewer's, never to the API door's token, never to a
// loopback read without a session. The actions are the UI session's (src/http/ui/logins.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import { LOGIN_STATUSES, roleAllows } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import { userIdOf, type TenantParts } from './tenants.ts';
import type { UiSessions } from './ui/sessions.ts';

/** `open`: pending or expired, so the user may still act on it. */
export const loginsQuery = z.object({
  status: z.enum([...LOGIN_STATUSES, 'open', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

export function loginRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; sessions: UiSessions; clock: Clock }): void {
  /** The request carries a UI session of the user it reads as, whose role may act on a login. */
  const ownSession = (req: FastifyRequest): boolean => {
    const s = o.sessions.find(sessionToken(req));
    return s !== undefined && s.userId === userIdOf(req) && roleAllows(s.role, 'operator');
  };

  app.get('/api/logins', async (req) => {
    const q = parseWith(loginsQuery, req.query);
    const { logins } = o.tenant(req);
    const status = q.status === 'all' ? undefined : q.status === 'open' ? (['pending', 'expired'] as const) : [q.status];
    const secrets = ownSession(req);
    return {
      now: o.clock.now().toISOString(),
      settings: logins.settings(),
      logins: logins.list({ ...(status ? { status: [...status] } : {}), limit: q.limit }).map((l) => logins.view(l, secrets)),
    };
  });

  app.get('/api/logins/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { logins } = o.tenant(req);
    const l = logins.get(id);
    if (!l) throw new HttpError(404, `login ${id} not found`);
    return logins.view(l, ownSession(req));
  });
}
