// Drain a machine (issue #1511, design.md "Draining a machine"): an admin stops new placement on one machine, and the
// jobs on it run to their end; undrained, it takes new jobs again. Each machine of GET /api/machines carries `drained`.
// `hopper machine drain|undrain` posts here. Not a box action: it starts, stops and changes no work. Issue #2499: a drain
// names its reason, and ends by itself after `hours`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DRAIN_MAX_HOURS } from '../../domain/machines.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The machine, and whether to drain it (true, with its reason and hours) or undrain it (false). */
export const machineDrainBody = z.strictObject({
  machineId: z.string().min(1).max(200), drained: z.boolean(),
  reason: z.string().trim().min(1).max(300).optional(), hours: z.number().int().min(1).max(DRAIN_MAX_HOURS).optional(),
}).refine((b) => !b.drained || b.reason !== undefined, { message: 'a drain names its reason', path: ['reason'] });

/** Its part of the API reference (src/http/openapi.ts). */
export const MACHINE_DRAIN_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/drain', tag: 'Machines and usage', summary: 'Drain or undrain a machine', description: 'Issue #1511: `drained: true` stops new placement on the machine — the jobs on it run to their end, a job resuming there returns to its pane —, until a person undrains it (`drained: false`), or until it ends by itself `hours` later (1 to 720, default 24; `machine.drain_expired`, issue #2499). A drain names its `reason`; one with none is a 400. Kept across restarts. Each machine of GET /api/machines carries `drained` (who, the way, when, why, until when) while it is drained. One `machine.drained` or `machine.undrained` event; none when nothing changes: a drain of a drained machine keeps its reason and end. `jobs`: the jobs still on the machine. `hopper machine drain|undrain <machine>` posts here. 404: no such machine (a drain).', role: 'admin', body: machineDrainBody, returns: '`{ machineId, drained, jobs }`', errors: [401, 404] },
];

export function registerMachineDrainRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/machines/drain', o.admin, async (req) => {
    const { machineId, drained, reason, hours } = parseWith(machineDrainBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, `sign in to ${drained ? 'drain' : 'undrain'} a machine`);
    return o.tenant(req).engine.machineDrains.set(machineId, drained, actingOf(s), reason === undefined ? undefined : { reason, ...(hours !== undefined ? { hours } : {}) });
  });
}
