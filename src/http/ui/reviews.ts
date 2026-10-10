// The UI session's actions on a review item (issues #537, #543): a person takes one of the decisions its section
// declares — Continue with selected (Accept, with the paths selected, issue #651), Ask for more paths, Steer, Reject
// all for a proposal; Accept, Dig deeper, Steer for a research report —
// (operator; who, by the session's sign-in), marks it seen; asks a job that has not started for the section's special
// job (operator); Accept in a phase a question switched the job to names what it does next (issue #548); and the section's settings (admin): the reviewer levels, who may sign off, how often the levels may
// send one back. A decision the section does not declare is no route: 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ReviewActionResult } from '../../domain/ports.ts';
import { MAX_LEVEL_REVISIONS, REVIEW_KINDS, REVIEW_SECTIONS, REVIEW_SIGN_OFF, SHIFT_THEN, type ReviewDecision, type ReviewKind } from '../../domain/types.ts';
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
/** A proposal's selected path (issue #651): its id, and the person's note for it. */
const pathPick = z.strictObject({ id: z.string().trim().min(1).max(8), note: z.string().trim().max(NOTES_MAX).optional() });
/** A proposal's selected paths: at Accept, the paths that continue; sent back, the selection kept for the next version. */
const paths = z.array(pathPick).max(50).optional();
/**
 * Accept: its notes, and — in a phase a question switched the job to (issue #548) — what the job does next; a
 * proposal's selected paths (issue #651).
 */
export const acceptBody = optionalNotesBody.extend({ then: z.enum(SHIFT_THEN).optional(), paths });
/** Any part, or several; a part left out keeps its value. */
export const reviewSettingsBody = z.strictObject({
  reviewers: z.array(z.string().min(1)).max(16).optional(),
  signOff: z.enum(REVIEW_SIGN_OFF).optional(),
  levelRevisions: z.number().int().min(0).max(MAX_LEVEL_REVISIONS).optional(),
}).refine((b) => b.reviewers !== undefined || b.signOff !== undefined || b.levelRevisions !== undefined, { message: 'name reviewers, signOff or levelRevisions' });

/** The body a decision takes: a proposal's that sends it back also keeps a selection (issue #651). */
export function decisionBody(kind: ReviewKind, d: ReviewDecision): z.ZodType {
  if (d.effect === 'accept') return acceptBody;
  const keeps = kind === 'proposal' && d.effect === 'send_back';
  const base = d.notes === 'required' ? notesBody : optionalNotesBody;
  return keeps ? base.extend({ paths }) : base;
}

const STATUS = { not_found: 404, not_open: 409, not_offered: 404, not_switched: 409, bad_selection: 400, no_paths: 409 } as const;

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
      const body = decisionBody(kind, d);
      app.post(`/ui/api/${section}/:id/${d.route}`, o.operator, async (req) => {
        const b = parseWith(body, req.body ?? {}) as { notes?: string; then?: (typeof SHIFT_THEN)[number]; paths?: { id: string; note?: string }[] };
        const picks = b.paths?.map((x) => ({ id: x.id, ...(x.note ? { note: x.note } : {}) }));
        return answer(req, o.tenant(req).reviews[kind].decide(id(req), d.id, who(req), b.notes || undefined, b.then, picks));
      });
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
