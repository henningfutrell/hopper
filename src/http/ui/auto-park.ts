// Auto-park (issue #650, design.md "Parked jobs"): how long a question waits on a person before its job parks by itself,
// one timeout for high-priority jobs and one for the rest, in minutes; 0 turns it off. An admin's; read on each tick, so
// a change applies without a restart. Read at GET /api/auto-park.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_AUTO_PARK_MINUTES, type AutoParkSettings } from '../../domain/types.ts';
import { autoParkSettings } from '../../engine/auto-park.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const minutes = z.number().min(0).max(MAX_AUTO_PARK_MINUTES);
/** Either timeout; one left out keeps its value. */
export const autoParkBody = z.strictObject({
  minutes: minutes.optional(),
  highPriorityMinutes: minutes.optional(),
}).refine((b) => b.minutes !== undefined || b.highPriorityMinutes !== undefined, { message: 'name minutes or highPriorityMinutes' });

export const autoParkView = (t: Pick<TenantParts, 'store'>): AutoParkSettings => autoParkSettings(t.store);

export function registerAutoParkRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/auto-park', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change auto-park');
    const t = o.tenant(req);
    const patch = parseWith(autoParkBody, req.body);
    t.store.tx(() => {
      const from = autoParkSettings(t.store);
      const to: AutoParkSettings = { minutes: patch.minutes ?? from.minutes, highPriorityMinutes: patch.highPriorityMinutes ?? from.highPriorityMinutes };
      if (from.minutes === to.minutes && from.highPriorityMinutes === to.highPriorityMinutes) return;
      t.store.settings.setAutoPark(to);
      t.store.events.append({ type: 'auto_park.settings_changed', data: { from, to, by: identityName(s.identity) } });
    });
    return autoParkView(t);
  });
}
