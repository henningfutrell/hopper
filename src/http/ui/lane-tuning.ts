// Lane tuning (issue #688, design.md "Lane tuning"): an admin changes one machine's lane tuning settings — auto-tune on
// or off, the least and most lanes a recommendation may name —, applies a machine's lane recommendation (its configured
// lanes, set as an edit of the machine sets them), dismisses it until it moves, and undoes the last one applied. The
// answer is every machine's lane recommendation, as GET /api/lanes/plan answers it (and `hopper lanes plan`: the same route).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_TUNED_LANES } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const lanes = z.number().int().min(0).max(MAX_TUNED_LANES);
const machineId = z.string().min(1).max(200);
/** One machine's settings; a field left out keeps its value. */
export const laneTuningBody = z.strictObject({
  machineId,
  autoTune: z.boolean().optional(),
  minLanes: lanes.optional(),
  maxLanes: lanes.optional(),
}).refine((b) => b.autoTune !== undefined || b.minLanes !== undefined || b.maxLanes !== undefined, { message: 'name autoTune, minLanes or maxLanes' });
/** The machine whose recommendation to apply; `lanes`: the lanes the admin saw, refused when the recommendation moved since. */
export const laneApplyBody = z.strictObject({ machineId, lanes: lanes.optional() });
/** The machine whose recommendation to dismiss, or whose last applied one to undo. */
export const laneMachineBody = z.strictObject({ machineId });

const PLAN = '`LaneTuningPlan`';
/** Lane tuning's part of the API reference (src/http/openapi.ts). */
export const LANE_TUNING_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/lanes/plan', tag: 'Machines and usage', summary: 'Lane recommendations', description: 'Issue #688: per machine, the lanes it can run (`lanes`) next to the configured lanes (`configured`), with the reason and a confidence from 0 to 1. From the machine samples of the last 7 days — the most lanes in use without resource pressure, and what each lane\'s measured cost leaves room for (`headroom`) — and the usage it burns against the usage limits: no lanes added near the soft limit or past it. Within each machine\'s bounds. When the `lane-count` decider call is active and Jev was sure, the lanes are Jev\'s pick from the lanes the rules allow (`decidedBy: jev`), with the rules\' own recommendation in `rules`. The hopper applies none by itself. `apply` when an admin can apply it, `dismissed` when one dismissed it, `undo` when the last one applied can be undone. `changes`: the latest lane changes, newest first. `hopper lanes plan` answers the same.', returns: PLAN },
  { method: 'get', path: '/api/lanes/costs', tag: 'Machines and usage', summary: 'Job cost profiles', description: 'Issue #688: per finished job of the last 30 days (the latest 100, newest first), what its runs cost on their machine: one lane\'s share of CPU busy, memory and disk (`avg`, `peak`), net of the machine\'s baseline — its samples with no lane in use —, the duration, and per usage window the share of its limit the job burned (`usage`). `groups`: the profiles grouped by repository (`repo`), job cost kind (`kind`: code, research, proposal) and the template of a sandbox box (`template`), with the mean of each figure. `hopper lanes costs` answers the same.', returns: '`JobCosts`' },
  { method: 'post', path: '/ui/api/lanes/tuning', tag: 'Machines and usage', summary: 'Set a machine\'s lane tuning', description: 'Issue #688: auto-tune on or off for one machine, and the least and most lanes its recommendation may name (0 to 64, the least at most the most). A field left out keeps its value. One `lanes.tuning_changed` event.', role: 'admin', body: laneTuningBody, returns: PLAN, errors: [404] },
  { method: 'post', path: '/ui/api/lanes/apply', tag: 'Machines and usage', summary: 'Apply a machine\'s lane recommendation', description: 'Issue #688: the machine\'s configured lanes become the recommended lanes, set as an edit of the machine sets them (POST /ui/api/plugins). One `lanes.applied` event with the reason. 409 when there is nothing to apply (the configured lanes, too little history, auto-tune off, offline, dismissed) or when `lanes` is not the recommendation now.', role: 'admin', body: laneApplyBody, returns: PLAN, errors: [404, 409] },
  { method: 'post', path: '/ui/api/lanes/dismiss', tag: 'Machines and usage', summary: 'Dismiss a machine\'s lane recommendation', description: 'Issue #688: not offered again until the recommended or the configured lanes move. One `lanes.dismissed` event. 409 when there is nothing to dismiss.', role: 'admin', body: laneMachineBody, returns: PLAN, errors: [404, 409] },
  { method: 'post', path: '/ui/api/lanes/undo', tag: 'Machines and usage', summary: 'Undo the last lane recommendation applied', description: 'Issue #688: the machine\'s configured lanes go back to what they were before it, set as an edit of the machine sets them. One `lanes.undone` event. 409 when there is none to undo: none applied, an undo already, or the lanes edited by hand since.', role: 'admin', body: laneMachineBody, returns: PLAN, errors: [404, 409] },
];

export function registerLaneTuningRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const by = (req: FastifyRequest, what: string): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, `sign in to ${what}`);
    return identityName(s.identity);
  };
  app.post('/ui/api/lanes/tuning', o.admin, async (req) => {
    const who = by(req, 'change lane tuning');
    const { machineId: id, ...patch } = parseWith(laneTuningBody, req.body);
    return o.tenant(req).engine.laneTuning.set(id, patch, who);
  });
  app.post('/ui/api/lanes/apply', o.admin, async (req) => {
    const who = by(req, 'apply a lane recommendation');
    const b = parseWith(laneApplyBody, req.body);
    return o.tenant(req).engine.laneTuning.apply(b.machineId, who, b.lanes);
  });
  app.post('/ui/api/lanes/dismiss', o.admin, async (req) => {
    const who = by(req, 'dismiss a lane recommendation');
    return o.tenant(req).engine.laneTuning.dismiss(parseWith(laneMachineBody, req.body).machineId, who);
  });
  app.post('/ui/api/lanes/undo', o.admin, async (req) => {
    const who = by(req, 'undo a lane change');
    return o.tenant(req).engine.laneTuning.undo(parseWith(laneMachineBody, req.body).machineId, who);
  });
}
