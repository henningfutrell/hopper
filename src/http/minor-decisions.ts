// The decider calls read (issue #550, design.md "Decider calls"): whether Jev can be asked, each decision point's
// settings and agreement rates over the window, and the newest picks with what was decided. The settings and the
// overrides are the UI session's (src/http/ui/minor-decisions.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

export function minorDecisionRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/minor-decisions', async (req) => o.tenant(req).minorDecisions.view());
}
