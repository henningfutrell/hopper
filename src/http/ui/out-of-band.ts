// Out-of-band changes on Infra changes (issue #871, design.md "Out-of-band changes"): the infrastructure changes the
// user's jobs' checks found that did not come through IaC or GitOps, each with its mark; a person's mark on one; and the
// controller identities, whose writes are GitOps's. Tracking only: nothing here reverts a change. Registered with the
// infra plans' routes (`infra-plans.ts`).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MARKS } from '../../domain/out-of-band.ts';
import { isPlanRefusal } from '../../infra-plans/service.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const outOfBandBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mark'), change: z.string().max(64), mark: z.enum(MARKS), reason: z.string().max(1000).optional() }),
  z.strictObject({ action: z.literal('controllers'), identities: z.array(z.string().max(300)).max(100) }),
]);

export const OUT_OF_BAND_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/out-of-band', tag: 'Vault', summary: 'Infra changes: out-of-band changes', description: 'Issue #871: the infrastructure changes the user\'s jobs\' read-only checks reported that did not come through IaC or GitOps, newest first, at most 200: each one\'s `source` (`gitops`, `terraform-plan`, `cloudtrail`, `kube-audit`), `key` (the signal\'s own id), `target`, `what`, `who`, `at`, `detail`, the `job` that reported it, `recordedAt`, and `marked` once a person marked it; and `controllers`, the controller identities. A job reports signals with POST /job/infra-signals (its proxy token). Not cached.', returns: '{ changes: OutOfBandView[]; controllers: string[] }' },
  { method: 'post', path: '/ui/api/out-of-band', tag: 'Vault', summary: 'Mark an out-of-band change, or set the controller identities', description: 'Issue #871. `action` `mark`: `change` its id, `mark` `adopted` (brought back into git), `reverted`, or `accepted` with a `reason`; a row of its own (`infra.out_of_band_marked`); the change does not change; nothing is reverted by the hopper. 404: no such change; 409: marked already. `action` `controllers`: `identities`, the whole list of principals whose writes are GitOps\'s (a trailing `*` names a group; `*` alone is refused); `infra.controllers_changed`.', role: 'admin', body: outOfBandBody, returns: '{ change: OutOfBandView } | { controllers: string[] }', errors: [400, 404, 409] },
];

export function outOfBandReadRoutes(app: FastifyInstance, { tenant }: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/out-of-band', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const changes = tenant(req).githubProxy.outOfBand;
    return { changes: changes.list(), controllers: changes.controllers() };
  });
}

export function registerOutOfBandRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/out-of-band', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to mark a change');
    const b = parseWith(outOfBandBody, req.body);
    const changes = o.tenant(req).githubProxy.outOfBand;
    const by = identityName(s.identity);
    if (b.action === 'controllers') {
      const r = changes.setControllers(b.identities.filter((i) => i.trim()), by);
      if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
      return { controllers: r };
    }
    const r = changes.mark(b.change, b.mark, b.reason, by);
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { change: r };
  });
}
