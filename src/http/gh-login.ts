// gh login, read side (design.md "gh login", issue #138): the gh CLI's login, or the device code it waits on.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

/** The request's user's gh login (their own gh config dir, issue #158). */
export function ghLoginRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/gh-login', async (req) => o.tenant(req).ghLogin.status());
}
