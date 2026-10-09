// The priority lane settings (issue #535, admin): the high-priority threshold, how many priority lanes, what one does
// while no high-priority job waits, the window and minimum runs of lane reliability, and an admin's choice of lanes
// (`manual`; null: back to reliability). Read at each Decision, so they apply without a restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PRIORITY_LANE_IDLE } from '../../domain/types.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Any setting; one left out keeps its value. The engine checks the bounds and the lanes. */
export const priorityLaneSettingsBody = z.strictObject({
  highPriority: z.number().optional(),
  count: z.number().optional(),
  whenIdle: z.enum(PRIORITY_LANE_IDLE).optional(),
  windowDays: z.number().optional(),
  minRuns: z.number().optional(),
  manual: z.array(z.string()).nullable().optional(),
});

export function registerPriorityLaneRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/priority-lanes/settings', o.admin, async (req) => {
    const { engine } = o.tenant(req);
    await engine.priorityLanes.setSettings(parseWith(priorityLaneSettingsBody, req.body));
    return engine.priorityLanes.view();
  });
}
