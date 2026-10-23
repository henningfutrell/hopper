// The expedite flag (issue #2554 part 4, design.md "Delivery forecasts"): POST /ui/api/delivery-expedite, a person's flag
// on one change — a job, an issue or a pull request —, recorded as `delivery_expedite.changed`. GET
// /api/delivery-forecast reads the flags at each request: an expedited change shows the expedited path beside the
// normal one. It changes no job, no queue and no promotion.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { expediteTargetOf, targetFlag, type DeliveryExpediteView } from '../../domain/delivery-expedite.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const deliveryExpediteBody = z.strictObject({
  job: z.string().min(1).max(200).optional(),
  issue: z.string().regex(/^[\w.-]+\/[\w.-]+#\d+$/).optional(),
  pr: z.url().max(500).optional(),
  expedite: z.boolean(),
}).refine((b) => [b.job, b.issue, b.pr].filter((v) => v !== undefined).length === 1, { message: 'name one of job, issue or pr' });

export const DELIVERY_EXPEDITE_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/delivery-expedite', tag: 'Jobs', summary: 'Turn the expedite flag of a change on or off', description: 'Issue #2554 part 4: names exactly one of `job` (a job id), `issue` (`owner/name#N`) or `pr` (a pull request URL), and `expedite` on or off (`delivery_expedite.changed`). A change is expedited when the newest flag that names its job, its issue or its pull request is on: its delivery forecast (`GET /api/delivery-forecast`) then has `expedited` `{ by, at }` and `forecast.expedited`, the fastest path its promotion set schedule allows (with `expedite: out_of_cadence`, a set of its own at once), beside the normal path and never later. It changes no job, no queue and no promotion. The same flag again on that target records nothing. The answer: the target, `expedite`, and when on, `by` and `at`.', role: 'operator', body: deliveryExpediteBody, returns: '`DeliveryExpediteView`', errors: [400] },
];

export function registerDeliveryExpediteRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/delivery-expedite', o.operator, async (req): Promise<DeliveryExpediteView> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to expedite a change');
    const t = o.tenant(req);
    const b = parseWith(deliveryExpediteBody, req.body);
    const target = expediteTargetOf(b);
    const flag = () => targetFlag(t.store.events.between(['delivery_expedite.changed'], new Date(0).toISOString()), target);
    // Only the target's own flag the same again records nothing: an off on a never-flagged job still overrides an older
    // flag on its issue or pull request.
    t.store.tx(() => {
      if (flag()?.expedite === b.expedite) return;
      t.store.events.append({ type: 'delivery_expedite.changed', data: { ...target, expedite: b.expedite, by: personOf(s) } });
    });
    const f = flag()!;
    return { ...target, expedite: f.expedite, ...(f.expedite ? { by: f.by, at: f.at } : {}) };
  });
}
