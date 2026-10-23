// Gate clearances (issue #2554 part 5, design.md "Delivery forecasts"): POST /ui/api/delivery-gate, a person's act that
// ends a delivery gate for one promotion set of a repository, recorded as `delivery_gate.cleared`. GET
// /api/delivery-forecast reads the clearances at each request: each change of that set goes on past the gate from the
// clearance. It changes no job, no queue and no promotion: the hopper records the act, it does not promote.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gateClearancesOf, type DeliveryGateClearanceView } from '../../domain/delivery-gates.ts';
import { DEFAULT_DELIVERY_SETTINGS, deliveryOf } from '../../domain/delivery-settings.ts';
import { SCHEDULED_STEPS, type DeliveryStep } from '../../domain/delivery-steps.ts';
import { MAX_SET, promotionSetNumbered } from '../../domain/promotion-sets.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const deliveryGateBody = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  set: z.number().int().min(1).max(MAX_SET),
  step: z.enum(SCHEDULED_STEPS as [DeliveryStep, ...DeliveryStep[]]),
});

export const DELIVERY_GATE_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/delivery-gate', tag: 'Jobs', summary: 'Clear a delivery gate of a promotion set', description: 'Issue #2554 part 5: a person ends the delivery gate at `step` (`promotion_set`, `test_gate` or `production`) for promotion set `set` of `repo` (`owner/name`, lowercased) — the test gate\'s sign-off, a production approval (`delivery_gate.cleared`). Each change of that set then goes on past the gate from the clearance, not before the step starts; a cleared production gate delivers it. The first clearance of a gate counts: the same again records nothing and answers the first. It changes no job and promotes nothing. 404: the repository has no promotion set schedule, or no such set. 409: the step has no delivery gate in the repository\'s delivery settings.', role: 'operator', body: deliveryGateBody, returns: '`DeliveryGateClearanceView` `{ repo, set, step, by, at }`', errors: [400, 404, 409] },
];

export function registerDeliveryGateRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/delivery-gate', o.operator, async (req): Promise<DeliveryGateClearanceView> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to clear a delivery gate');
    const t = o.tenant(req);
    const b = parseWith(deliveryGateBody, req.body);
    const repo = b.repo.toLowerCase();
    const d = deliveryOf(t.store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS, repo);
    if (!d.schedule) throw new HttpError(404, `${repo} has no promotion set schedule`);
    if (!promotionSetNumbered(d.schedule, b.set)) throw new HttpError(404, `${repo} has no promotion set ${b.set}`);
    if (!d.gates[b.step]) throw new HttpError(409, `${repo} has no delivery gate at ${b.step}`);
    const cleared = () => gateClearancesOf(t.store.events.between(['delivery_gate.cleared'], new Date(0).toISOString()), repo, b.set)[b.step];
    t.store.tx(() => {
      if (cleared()) return;
      t.store.events.append({ type: 'delivery_gate.cleared', data: { repo, set: b.set, step: b.step, by: personOf(s) } });
    });
    return { repo, set: b.set, step: b.step, ...cleared()! };
  });
}
