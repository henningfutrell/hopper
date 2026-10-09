// The UI session's actions on a review item (issues #537, #543): a person takes one of the decisions its section
// declares — Accept, Reject, Request changes for a proposal; Accept, Dig deeper, Steer for a research report —
// (operator; who, by the session's sign-in), marks it seen; asks a job that has not started for the section's special
// job (operator); and the section's settings (admin): the reviewer levels, who may sign off, how often the levels may
// send one back. A decision the section does not declare is no route: 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ReviewActionResult } from '../../domain/ports.ts';
import { MAX_LEVEL_REVISIONS, REVIEW_KINDS, REVIEW_SECTIONS, REVIEW_SIGN_OFF } from '../../domain/types.ts';
import { editReviewSettings } from '../../review/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { reviewItemView } from '../reviews.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
const NOTES_MAX = 16 * 1024;
/** A decision whose notes are optional: an acceptance's note, a dig deeper's open threads. */
export const optionalNotesBody = z.strictObject({ notes: z.string().trim().max(NOTES_MAX).optional() });
/** A rejection, a request for changes or a steer says why, or where: the job and the trail are told. */
export const notesBody = z.strictObject({ notes: z.string().trim().min(1, 'say why').max(NOTES_MAX) });
/** Any part, or several; a part left out keeps its value. */
export const reviewSettingsBody = z.strictObject({
  reviewers: z.array(z.string().min(1)).max(16).optional(),
  signOff: z.enum(REVIEW_SIGN_OFF).optional(),
  levelRevisions: z.number().int().min(0).max(MAX_LEVEL_REVISIONS).optional(),
}).refine((b) => b.reviewers !== undefined || b.signOff !== undefined || b.levelRevisions !== undefined, { message: 'name reviewers, signOff or levelRevisions' });

const STATUS = { not_found: 404, not_open: 409, not_offered: 404 } as const;

export function registerReviewRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const id = (req: FastifyRequest) => parseWith(idParams, req.params).id;
  for (const kind of REVIEW_KINDS) {
    const { section, noun, askPath, decisions } = REVIEW_SECTIONS[kind];
    /** Who decides: the person the session signed in. */
    const who = (req: FastifyRequest): string => {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, `sign in to decide on a ${noun}`);
      return identityName(s.identity);
    };
    const answer = (req: FastifyRequest, r: ReviewActionResult) => {
      if (r.ok) return reviewItemView(o.tenant(req).store, r.item);
      throw new HttpError(STATUS[r.reason], r.message);
    };
    for (const d of decisions) {
      const body = d.notes === 'required' ? notesBody : optionalNotesBody;
      app.post(`/ui/api/${section}/:id/${d.route}`, o.operator, async (req) =>
        answer(req, o.tenant(req).reviews[kind].decide(id(req), d.id, who(req), parseWith(body, req.body ?? {}).notes || undefined)));
    }
    app.post(`/ui/api/${section}/:id/seen`, o.operator, async (req) => answer(req, o.tenant(req).reviews[kind].markSeen(id(req))));
    app.post(`/ui/api/jobs/:id/${askPath}`, o.operator, async (req) => o.tenant(req).engine.askFor(kind, id(req)));
    // Read at each review: applies without a restart.
    app.post(`/ui/api/${section}/settings`, o.admin, async (req) => {
      const t = o.tenant(req);
      const r = editReviewSettings(t.store, kind, t.levelNames(), parseWith(reviewSettingsBody, req.body));
      if (!r.ok) throw new HttpError(400, r.error);
      return r.view;
    });
  }
}
