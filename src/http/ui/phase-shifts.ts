// Phase shifts from a question (issue #548): Research this and Propose this on an open question (operator; who, by
// the session's sign-in), as a fork or a switch — none named: the default mode — with an optional note scoping the
// aspect; and the phase-shift settings (admin): the default mode, what a parent does while its fork runs, the
// escalation levels that may shift a job themselves. Read at each shift, so they apply without a restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FORK_PARENT, SHIFT_MODES, withPhase, type ReviewKind } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import { questionView } from '../questions.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
const NOTE_MAX = 4 * 1024;
export const shiftBody = z.strictObject({
  mode: z.enum(SHIFT_MODES).optional(),
  note: z.string().trim().max(NOTE_MAX).optional(),
});
/** Any part, or several; a part left out keeps its value. */
export const phaseShiftSettingsBody = z.strictObject({
  defaultMode: z.enum(SHIFT_MODES).optional(),
  forkParent: z.enum(FORK_PARENT).optional(),
  levels: z.array(z.string().min(1)).max(16).optional(),
}).refine((b) => b.defaultMode !== undefined || b.forkParent !== undefined || b.levels !== undefined, { message: 'name defaultMode, forkParent or levels' });

/** The route of each shift: the same words as asking a job that has not started (src/domain/review.ts askPath). */
const SHIFTS: readonly [string, ReviewKind][] = [['research', 'research'], ['propose', 'proposal']];

export function registerPhaseShiftRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  for (const [path, to] of SHIFTS) {
    app.post(`/ui/api/questions/:id/${path}`, o.operator, async (req) => {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, 'sign in to shift a job\'s phase');
      const { id } = parseWith(idParams, req.params);
      const body = parseWith(shiftBody, req.body ?? {});
      const t = o.tenant(req);
      const r = t.engine.phaseShifts.shift(id, { to, ...(body.mode ? { mode: body.mode } : {}), ...(body.note ? { note: body.note } : {}) }, { person: identityName(s.identity) });
      return { question: questionView(t, r.question), job: withPhase(r.job), ...(r.fork ? { fork: withPhase(r.fork) } : {}) };
    });
  }
  app.post('/ui/api/phase-shifts', o.admin, async (req) => {
    const t = o.tenant(req);
    const r = t.engine.phaseShifts.edit(parseWith(phaseShiftSettingsBody, req.body), t.levelNames());
    if (!r.ok) throw new HttpError(400, r.error);
    return r.view;
  });
}
