// Connected accounts, read side (issue #214, design.md "Connected accounts"): the request's user's
// GitHub account — connected (as whom), waiting on a device code, failed, or not connected.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

export function connectedAccountsRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/connected-accounts', async (req) => ({ accounts: await o.tenant(req).connectedAccounts.status() }));
}
