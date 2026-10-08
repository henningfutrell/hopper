// The UI session's actions on one job: cancel, approve, operator-led, reject, run again, park and re-queue
// (issue #501), dismiss, mark cleaned up. Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';
import { rejectBody } from './job-bodies.ts';

const idParams = z.object({ id: z.string() });
const RERUN_STATUS = { not_found: 404, conflict: 409, source: 502 } as const;

export function registerJobActionRoutes(app: FastifyInstance, o: {
  operator: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
}): void {
  app.post('/ui/api/jobs/:id/cancel', o.operator, async (req) => o.tenant(req).engine.cancel(parseWith(idParams, req.params).id, 'cancelled in UI'));
  app.post('/ui/api/jobs/:id/approve', o.operator, async (req) => o.tenant(req).engine.approve(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/operator-led', o.operator, async (req) => o.tenant(req).engine.claimByOperator(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/reject', o.operator, async (req) => o.tenant(req).engine.reject(parseWith(idParams, req.params).id, parseWith(rejectBody, req.body ?? {}).reason));
  app.post('/ui/api/jobs/:id/rerun', o.operator, async (req) => {
    const r = await o.tenant(req).registry.rerun(parseWith(idParams, req.params).id);
    if (r.ok) return r.job;
    throw new HttpError(RERUN_STATUS[r.reason], r.message);
  });
  app.post('/ui/api/jobs/:id/park', o.operator, async (req) => o.tenant(req).engine.park(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/requeue', o.operator, async (req) => o.tenant(req).engine.requeue(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/dismiss', o.operator, async (req) => o.tenant(req).engine.dismiss(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/cleaned-up', o.operator, async (req) => o.tenant(req).engine.markCleanedUp(parseWith(idParams, req.params).id));
}
