// The failures read (issue #509, design.md "Failure assessment"): the open problems, the newest assessed failures,
// the profile, the known causes and the settings, each problem and failure with the actions the daemon takes now
// and why not. The actions are the UI session's (src/http/ui/failures.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantParts } from './tenants.ts';

export function failureRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/failures', async (req) => o.tenant(req).failures.view());
}
