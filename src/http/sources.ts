// GET /api/sources: every configured job source and its sync status (design.md "Job sources").
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

export function sourceRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/sources', async (req) => ({ sources: o.tenant(req).registry.statuses() }));
}
