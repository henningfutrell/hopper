// The UI session's actions on one job: cancel, approve, operator-led, reject, run again, park and re-queue
// (issue #501), end its own wait (issue #483), dismiss, mark cleaned up; for a job held because its item changed since
// the snapshot (issue #662), keep the original text, or accept the new text — the owner only, as Access decides. Least role: operator.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';
import { endWaitBody, rejectBody, requeueBody } from './job-bodies.ts';
import type { Access } from '../../authz/service.ts';
import { signedInOf } from '../tenants.ts';
import { actingOf } from './sessions.ts';

const idParams = z.object({ id: z.string() });
const RERUN_STATUS = { not_found: 404, conflict: 409, source: 502 } as const;

export function registerJobActionRoutes(app: FastifyInstance, o: {
  operator: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
  access: Pick<Access, 'decideTextAcceptance'>;
}): void {
  const signedIn = (req: FastifyRequest) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to act on a changed item');
    return s;
  };
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
  app.post('/ui/api/jobs/:id/requeue', o.operator, async (req) => o.tenant(req).engine.requeue(parseWith(idParams, req.params).id, parseWith(requeueBody, req.body ?? {})));
  app.post('/ui/api/jobs/:id/end-wait', o.operator, async (req) => {
    const { note } = parseWith(endWaitBody, req.body ?? {});
    return o.tenant(req).engine.endWait(parseWith(idParams, req.params).id, note || undefined);
  });
  app.post('/ui/api/jobs/:id/keep-original', o.operator, async (req) =>
    o.tenant(req).engine.keepOriginalText(parseWith(idParams, req.params).id, actingOf(signedIn(req).identity)));
  app.post('/ui/api/jobs/:id/accept-new-text', o.operator, async (req) => {
    const s = signedIn(req);
    const t = o.tenant(req);
    const job = t.store.jobs.get(parseWith(idParams, req.params).id);
    if (!job) throw new HttpError(404, `job ${parseWith(idParams, req.params).id} not found`);
    if (!job.textChange || !job.source) throw new HttpError(409, `job ${job.id} is not held for a changed item`);
    // The item is the hopper's user's whose jobs these are: Access decides whether the person signed in may accept for them.
    const d = await o.access.decideTextAcceptance(s.userId, { ownerId: s.userId, key: job.source.key });
    if (!d.allowed) throw new HttpError(403, `accepting the new text is refused: ${d.reason}`);
    return t.engine.acceptNewText(job.id, actingOf(s.identity));
  });
  app.post('/ui/api/jobs/:id/dismiss', o.operator, async (req) => o.tenant(req).engine.dismiss(parseWith(idParams, req.params).id));
  app.post('/ui/api/jobs/:id/cleaned-up', o.operator, async (req) => o.tenant(req).engine.markCleanedUp(parseWith(idParams, req.params).id));
}
