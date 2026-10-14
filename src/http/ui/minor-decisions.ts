// The UI session's actions on decider calls (issue #550): a decision point's mode and threshold (admin), a person's
// override of a pick (operator). Settings are kept in the database and apply from the next decision. The TypeSafe API
// key Jev asks with (issue #657): set — checked once against TypeSafe, then kept in the vault's system scope — or remove;
// the user's own or an admin's (least role operator, then Access decides), answered as its view, never the key, not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DECISION_POINTS, MINOR_DECISION_MODES, VAULT_VALUE_MAX, type DecisionPoint } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const pointParams = z.object({ point: z.string() });
const pickParams = z.object({ id: z.string() });
/** Either setting; one left out keeps its value. */
export const decisionPointBody = z.strictObject({
  mode: z.enum(MINOR_DECISION_MODES).optional(),
  threshold: z.number().min(0).max(1).optional(),
}).refine((b) => b.mode !== undefined || b.threshold !== undefined, { message: 'name a mode or a threshold' });
export const overrideBody = z.strictObject({ actual: z.string().min(1).max(200) });

export const typesafeKeyBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove') }),
]);
const KEY_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

const isPoint = (p: string): p is DecisionPoint => (DECISION_POINTS as readonly string[]).includes(p);

export function registerMinorDecisionRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/minor-decisions/points/:point', o.admin, async (req) => {
    const { point } = parseWith(pointParams, req.params);
    if (!isPoint(point)) throw new HttpError(404, `no decision point ${point}: ${DECISION_POINTS.join(', ')}`);
    const patch = parseWith(decisionPointBody, req.body);
    return o.tenant(req).minorDecisions.setPoint(point, {
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}), ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
    });
  });
  app.post('/ui/api/minor-decisions/picks/:id/override', o.operator, async (req) => {
    const { id } = parseWith(pickParams, req.params);
    const r = o.tenant(req).minorDecisions.override(id, parseWith(overrideBody, req.body).actual);
    if (r.ok) return r.value;
    throw new HttpError(r.reason === 'not_found' ? 404 : 400, r.message);
  });
  app.post('/ui/api/typesafe-key', o.operator, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the TypeSafe API key');
    const { typesafeKey } = o.tenant(req);
    const edit = parseWith(typesafeKeyBody, req.body);
    const who = { userId: s.userId, admin: s.role === 'admin', by: identityName(s.identity) };
    const r = edit.action === 'set' ? await typesafeKey.set(edit.value, who) : await typesafeKey.remove(who);
    if (!r.ok) throw new HttpError(KEY_STATUS[r.code], r.error);
    return r.view;
  });
}
