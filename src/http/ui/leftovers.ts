// Leftovers (issue #1116, design.md "Leftovers a person decides"): a person keeps or removes one leftover the sweep listed on a
// machine — a dir in a work tree's `.hopper-scratch` of no job the hopper knows, or a repository mirror there. Each machine of
// GET /api/machines carries its listing (`leftovers`). A box action: a removal changes the work on a machine.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A person's decision on one leftover. */
export const leftoverDecisionBody = z.strictObject({
  machineId: z.string().min(1),
  path: z.string().min(1).max(4096),
  decision: z.enum(['keep', 'remove']),
});

/** The leftovers' part of the API reference (src/http/openapi.ts). */
export const LEFTOVER_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/leftovers', tag: 'Machines and usage', summary: 'Keep or remove a leftover', description: 'Issue #1116. The sweep lists, on each machine, what the layout before issue #1188 left in a work tree\'s `.hopper-scratch` that it does not judge: a dir of no job the hopper knows (another hopper\'s, a test\'s), and the repository mirrors there while one of those holds the layout. Each machine of GET /api/machines carries them as `leftovers`, with size, age, whether each holds work not pushed, and a keep that stands. `keep` records `machine.leftover_kept` and removes nothing. `remove` removes the dir on its machine whatever it holds — work not pushed is lost —, then records `machine.leftover_removed`. The sweep removes none by itself. A box action. 409: the path is no leftover listed on that machine, or the machine is offline, out of reach, or could not remove it.', role: 'operator', body: leftoverDecisionBody, returns: '`{ machineId, path, decision }`', errors: [401, 404, 409] },
];

export function registerLeftoverRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/machines/leftovers', o.operator, async (req) => {
    const { machineId, path, decision } = parseWith(leftoverDecisionBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to decide on a leftover');
    return o.tenant(req).engine.decideLeftover(machineId, path, decision, actingOf(s));
  });
}
