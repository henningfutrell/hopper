// Lane tuning (issue #688, design.md "Lane tuning"): an admin changes one machine's lane tuning settings — auto-tune on
// or off, the least and most lanes a recommendation may name, shadow or active mode —, and undoes the last change active
// mode applied. The answer is every machine's lane recommendation, as GET /api/lanes/plan answers it (and `hopper lanes
// plan`: the same route).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LANE_TUNING_MODES, MAX_TUNED_LANES } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const lanes = z.number().int().min(0).max(MAX_TUNED_LANES);
/** One machine's settings; a field left out keeps its value. */
export const laneTuningBody = z.strictObject({
  machineId: z.string().min(1).max(200),
  autoTune: z.boolean().optional(),
  minLanes: lanes.optional(),
  maxLanes: lanes.optional(),
  mode: z.enum(LANE_TUNING_MODES).optional(),
}).refine((b) => b.autoTune !== undefined || b.minLanes !== undefined || b.maxLanes !== undefined || b.mode !== undefined, { message: 'name autoTune, minLanes, maxLanes or mode' });
/** The machine whose last lane change to undo. */
export const laneUndoBody = z.strictObject({ machineId: z.string().min(1).max(200) });

/** Lane tuning's part of the API reference (src/http/openapi.ts). */
export const LANE_TUNING_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/lanes/plan', tag: 'Machines and usage', summary: 'Lane recommendations', description: 'Issue #688: per machine, the lanes it can run (`lanes`) next to the configured lanes (`configured`), with the reason and a confidence from 0 to 1. From the machine samples of the last 7 days — the most lanes in use without resource pressure, and what each lane\'s measured cost leaves room for (`headroom`) — and the usage it burns against the usage limits: no lanes added near the soft limit or past it. Within each machine\'s bounds. `inUse`: the lanes the decider uses — the configured lanes in shadow mode, the applied lanes in active mode; `undo` when the last change can be undone. `changes`: the latest lane changes, newest first. `hopper lanes plan` answers the same.', returns: '`LaneTuningPlan`' },
  { method: 'post', path: '/ui/api/lanes/tuning', tag: 'Machines and usage', summary: 'Set a machine\'s lane tuning', description: 'Issue #688: auto-tune on or off for one machine, the least and most lanes its recommendation may name (0 to 64, the least at most the most), and `mode`: `shadow` (recommend only) or `active` (apply the recommendation within the bounds). A field left out keeps its value. Out of active mode, or auto-tune off, the configured lanes apply again. One `lanes.tuning_changed` event.', role: 'admin', body: laneTuningBody, returns: '`LaneTuningPlan`', errors: [404] },
  { method: 'post', path: '/ui/api/lanes/undo', tag: 'Machines and usage', summary: 'Undo a machine\'s last lane change', description: 'Issue #688: in active mode, the machine\'s lanes go back to what they were before the last change lane tuning applied; those lanes are not applied again until the recommendation moves. One `lanes.undone` event. 409 when there is no change to undo.', role: 'admin', body: laneUndoBody, returns: '`LaneTuningPlan`', errors: [404, 409] },
];

export function registerLaneTuningRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/lanes/tuning', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change lane tuning');
    const { machineId, ...patch } = parseWith(laneTuningBody, req.body);
    return o.tenant(req).engine.laneTuning.set(machineId, patch, identityName(s.identity));
  });
  app.post('/ui/api/lanes/undo', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to undo a lane change');
    const { machineId } = parseWith(laneUndoBody, req.body);
    return o.tenant(req).engine.laneTuning.undo(machineId, identityName(s.identity));
  });
}
