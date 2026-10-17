// Infra applies (issue #1722, design.md "Infra applies off: changes through CI only"): Infra, the hopper's admin's.
// GET /api/infra-applies shows whether they are on, to every signed-in person; POST /ui/api/infra-applies turns them on or off.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InfraApplies, InfraAppliesView } from '../infra-applies.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const infraAppliesBody = z.strictObject({ on: z.boolean() });

export const INFRA_APPLIES_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/infra-applies', tag: 'Infra', summary: 'Whether this hopper applies infrastructure changes', description: 'Issue #1722. `on`: the vault mints a write, sync or apply credential for an approved, current plan, and need and box steps may apply. Off: the vault mints read credentials only, and runs no step with a plan or a need but read; an infrastructure change goes through CI. On by default.', returns: '`{ on: boolean }`', errors: [] },
  { method: 'post', path: '/ui/api/infra-applies', tag: 'Infra', summary: 'Turn infra applies on or off', description: 'Only the instance admin (issue #1722). `on`: true or false. Applies at once, to the next mint and the next step; a credential minted before keeps its expiry. A change is `infra.applies_changed`.', role: 'admin', body: infraAppliesBody, returns: '`{ on: boolean }`', errors: [400, 403] },
];

export function registerInfraAppliesRoutes(app: FastifyInstance, o: { instance: Guard; infraApplies: InfraApplies; by: (req: FastifyRequest) => string }): void {
  app.get('/api/infra-applies', async (): Promise<InfraAppliesView> => o.infraApplies.view());
  app.post('/ui/api/infra-applies', o.instance, async (req): Promise<InfraAppliesView> => o.infraApplies.change(parseWith(infraAppliesBody, req.body).on, o.by(req)));
}
