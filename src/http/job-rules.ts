// The job rules (issue #172): what every job's prompt carries before its work tree and the protocol —
// the config record `job-rules`, or the default while none is saved — with the default and the fixed
// lines. Edited through POST /ui/api/job-rules (src/http/ui/).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JobRulesView } from '../domain/types.ts';
import { jobRulesView } from '../job-rules/index.ts';
import type { TenantParts } from './tenants.ts';

export function jobRulesRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/job-rules', async (req): Promise<JobRulesView> => jobRulesView(o.tenant(req).store.config));
}
