// The UI session's intake actions on a job source (issue #440): Assign to me and Release claim, on items the
// source's last sync offered them for. The source syncs at once. Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';
import { intakeActionBody, sourceParams } from './job-bodies.ts';

export function registerSourceIntakeRoutes(app: FastifyInstance, o: {
  operator: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
}): void {
  app.post('/ui/api/sources/:name/intake', o.operator, async (req) => {
    const r = await o.tenant(req).registry.intakeAction(parseWith(sourceParams, req.params).name, parseWith(intakeActionBody, req.body));
    if (r.ok) return r.result;
    throw new HttpError(r.reason === 'not_found' ? 404 : 409, r.message);
  });
}
