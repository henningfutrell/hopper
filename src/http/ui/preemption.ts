// Preemption (issue #1525, design.md "Preemption"): whether a job of higher priority takes the lane of a running job of
// lower priority, and the minimum run time before a job may be preempted, in minutes. An admin's; read on each Decision,
// so a change applies without a restart. Read at GET /api/preemption.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_PREEMPTION_MIN_RUN_MINUTES, type PreemptionSettings } from '../../domain/types.ts';
import { preemptionSettings } from '../../engine/preemption.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Either part; one left out keeps its value. */
export const preemptionBody = z.strictObject({
  enabled: z.boolean().optional(),
  minRunMinutes: z.number().min(0).max(MAX_PREEMPTION_MIN_RUN_MINUTES).optional(),
}).refine((b) => b.enabled !== undefined || b.minRunMinutes !== undefined, { message: 'name enabled or minRunMinutes' });

export const preemptionView = (t: Pick<TenantParts, 'store'>): PreemptionSettings => preemptionSettings(t.store);

export function registerPreemptionRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/preemption', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change preemption');
    const t = o.tenant(req);
    const patch = parseWith(preemptionBody, req.body);
    t.store.tx(() => {
      const from = preemptionSettings(t.store);
      const to: PreemptionSettings = { enabled: patch.enabled ?? from.enabled, minRunMinutes: patch.minRunMinutes ?? from.minRunMinutes };
      if (from.enabled === to.enabled && from.minRunMinutes === to.minRunMinutes) return;
      t.store.settings.setPreemption(to);
      t.store.events.append({ type: 'preemption.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return preemptionView(t);
  });
}
