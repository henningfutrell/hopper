// Delivery settings (issue #2554 part 3, design.md "Delivery forecasts"): per repository, its promotion set schedule and
// its delivery gates. The user's, in the database, changed by an admin; GET /api/delivery-forecast reads them at each
// request, so a change applies with no restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DELIVERY_SETTINGS, patchDeliverySettings, type DeliverySettingsView } from '../../domain/delivery-settings.ts';
import { DELIVERY_STEPS } from '../../domain/delivery-steps.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const timeZone = z.string().min(1).max(64).refine((tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, 'an IANA time zone');
const MAX_MINUTES = 30 * 24 * 60;
export const deliveryRepoBody = z.strictObject({
  schedule: z.strictObject({
    timeZone,
    cutoffs: z.array(z.strictObject({ weekday: z.number().int().min(1).max(7), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM') })).min(1).max(28),
    testGateAfterMinutes: z.number().int().min(0).max(MAX_MINUTES),
    productionAfterMinutes: z.number().int().min(0).max(MAX_MINUTES),
    epoch: z.iso.datetime(),
    expedite: z.enum(['out_of_cadence', 'none']),
  }).optional(),
  gates: z.partialRecord(z.enum(DELIVERY_STEPS), z.strictObject({ owner: z.string().trim().min(1).max(100) })),
});
/** Per repository: its settings whole, or `null` to take them away. */
export const deliverySettingsBody = z.strictObject({ repos: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200), deliveryRepoBody.nullable()) });

export const DELIVERY_SETTINGS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/delivery-settings', tag: 'Jobs', summary: 'Delivery settings', description: 'Issue #2554 part 3: per repository (`owner/repo`, lowercased), its promotion set `schedule` and its delivery `gates`. `choices.repos` the job repositories, `choices.steps` the delivery steps. Not cached.', returns: '`DeliverySettingsView`' },
  { method: 'post', path: '/ui/api/delivery-settings', tag: 'Jobs', summary: 'Change the delivery settings', description: 'Issue #2554 part 3: `repos` sets each named repository\'s settings whole, or `null` takes them away (`delivery_settings.changed`). A `schedule`: the weekly `cutoffs` (ISO weekday 1–7, `HH:MM`) in its IANA `timeZone`, `testGateAfterMinutes` from a cutoff to the end of the test gate, `productionAfterMinutes` from there to production, its `epoch` (set 1 is the first cutoff after it) and `expedite` (`out_of_cadence` or `none`). `gates`: each delivery step a person ends, with its `owner`. Applies at the next forecast; a save that changes nothing records nothing.', role: 'admin', body: deliverySettingsBody, returns: '`DeliverySettingsView`', errors: [400] },
];

export function deliverySettingsView(t: Pick<TenantParts, 'store'>): DeliverySettingsView {
  return { settings: t.store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS, choices: { repos: t.store.settings.getJobRepositories('github'), steps: DELIVERY_STEPS } };
}

export function deliverySettingsReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/delivery-settings', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return deliverySettingsView(o.tenant(req));
  });
}

export function registerDeliverySettingsRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/delivery-settings', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the delivery settings');
    const t = o.tenant(req);
    const patch = parseWith(deliverySettingsBody, req.body);
    t.store.tx(() => {
      const from = t.store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS;
      const to = patchDeliverySettings(from, patch);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setDeliverySettings(to);
      t.store.events.append({ type: 'delivery_settings.changed', data: { from, to, by: personOf(s) } });
    });
    return deliverySettingsView(t);
  });
}
