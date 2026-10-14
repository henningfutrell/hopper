// Blast radius (issue #542): the settings (admin) — where the gate stands, what passes it, the rating rules, the actor
// machines, how often each machine is discovered —, a discovery now (operator: it only reads), and a person letting a
// job held at the gate through (admin: it widens what the job may reach). Read at each Decision: no restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GATE_AT, RADIUS_LEVELS, UNCONFIRMED_AS } from '../../domain/types.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Any setting, each replaced whole; one left out keeps its value. The engine checks names, bounds and machines. */
export const blastRadiusSettingsBody = z.strictObject({
  gateAt: z.enum(GATE_AT).optional(),
  pass: z.strictObject({ labels: z.array(z.string()).optional(), repos: z.array(z.string()).optional(), minPriority: z.number().nullable().optional() }).optional(),
  rules: z.strictObject({ prodPatterns: z.array(z.string()), prodAccounts: z.array(z.string()), unconfirmed: z.enum(UNCONFIRMED_AS) }).optional(),
  actors: z.array(z.strictObject({ machineId: z.string(), purpose: z.string(), expected: z.enum(RADIUS_LEVELS) })).max(64).optional(),
  everyMinutes: z.number().optional(),
});

/** One machine, or every online one. */
export const discoverBody = z.strictObject({ machineId: z.string().min(1).optional() });

const idParams = z.object({ id: z.string() });

export function registerBlastRadiusRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/blast-radius/settings', o.admin, async (req) => {
    const { engine } = o.tenant(req);
    await engine.blastRadius.setSettings(parseWith(blastRadiusSettingsBody, req.body));
    return engine.blastRadius.view();
  });
  app.post('/ui/api/blast-radius/discover', o.operator, async (req) =>
    o.tenant(req).engine.blastRadius.discoverNow(parseWith(discoverBody, req.body ?? {}).machineId));
  app.post('/ui/api/jobs/:id/gate-pass', o.admin, async (req) => o.tenant(req).engine.blastRadius.letThrough(parseWith(idParams, req.params).id));
}
