// The UI session's intake actions on a job source (issue #440): Assign to me and Release claim, on items the
// source's last sync offered them for; and Approve on a request card (issue #652) — the owner only, as Access decides
// (OpenFGA `item#can_accept_text`, as for accepting an item's new text), a person signed in, never a job. The source
// syncs at once. Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Access } from '../../authz/service.ts';
import { ACCESS_UNAVAILABLE } from '../../domain/access.ts';
import type { IntakeAction } from '../../domain/intake.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { intakeActionBody, sourceParams } from './job-bodies.ts';
import { actingOf } from './sessions.ts';

export function registerSourceIntakeRoutes(app: FastifyInstance, o: {
  operator: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
  access: Pick<Access, 'decideTextAcceptance'>;
}): void {
  app.post('/ui/api/sources/:name/intake', o.operator, async (req) => {
    const body = parseWith(intakeActionBody, req.body);
    let action: IntakeAction = body;
    if (body.kind === 'approve') {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, 'sign in to approve a request');
      // The item is the hopper's user's whose jobs these are: Access decides whether the person signed in may approve its text.
      const d = await o.access.decideTextAcceptance(s.userId, { ownerId: s.userId, key: body.keys[0]! });
      if (!d.allowed && d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      if (!d.allowed) throw new HttpError(403, `approving the request is refused: ${d.reason}`);
      action = { ...body, acting: actingOf(s.identity) };
    }
    const r = await o.tenant(req).registry.intakeAction(parseWith(sourceParams, req.params).name, action);
    if (r.ok) return r.result;
    throw new HttpError(r.reason === 'not_found' ? 404 : 409, r.message);
  });
}
