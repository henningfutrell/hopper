// Auto-answer (issue #632, design.md "Question pipeline"): its settings (admin) — on or off, and the least confidence a
// level's answer needs to go into the job — and a person's correction of an auto-answer (operator), which the job gets
// ahead of its next answer. The settings and the agreement stats are read at GET /api/question-gates.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import { CONFIDENCES } from '../../domain/types.ts';
import { editAutoAnswer } from '../../questions/auto-answer.ts';
import { HttpError, parseWith } from '../errors.ts';
import { questionView } from '../questions.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { answerBody } from './job-bodies.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
/** Either setting; one left out keeps its value. */
export const autoAnswerBody = z.strictObject({
  enabled: z.boolean().optional(),
  threshold: z.enum(CONFIDENCES).optional(),
}).refine((b) => b.enabled !== undefined || b.threshold !== undefined, { message: 'name enabled or threshold' });

export function registerAutoAnswerRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  const by = (req: FastifyRequest, what: string): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, `sign in to ${what}`);
    return identityName(s.identity);
  };

  app.post('/ui/api/auto-answer', o.admin, async (req) => {
    const who = by(req, 'change auto-answer');
    const r = editAutoAnswer(o.tenant(req).store, o.clock, parseWith(autoAnswerBody, req.body), who);
    if (!r.ok) throw new HttpError(400, r.error);
    return r.view;
  });

  app.post('/ui/api/questions/:id/correct', o.operator, async (req) => {
    const who = by(req, 'correct an answer');
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const t = o.tenant(req);
    const r = t.questions.correct(id, answer, who);
    if (r.ok) return questionView(t, r.question);
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, r.reason === 'job_ended' ? `question ${id}: its job ended, so a correction cannot reach it` : `question ${id} has no auto-answer to correct`);
  });
}
