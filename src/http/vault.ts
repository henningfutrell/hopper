// The vault (issue #558, design.md "The vault"): the read — its secrets' metadata, never a value, not cached. Changes
// are the UI session's (src/http/ui/vault.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

export function vaultRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/vault', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return await o.tenant(req).vault.view();
  });
}
