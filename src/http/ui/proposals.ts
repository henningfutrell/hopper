// The UI session's actions on a proposal (issue #537): a person accepts it, rejects it or sends it back with what to
// change (operator; who, by the session's sign-in), marks it seen; asks a job that has not started for one (operator);
// and the proposal settings (admin): the reviewer levels, who may sign off, how often the levels may send one back.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProposalActionResult } from '../../domain/ports.ts';
import { MAX_LEVEL_REVISIONS, PROPOSAL_SIGN_OFF } from '../../domain/types.ts';
import { editProposalSettings } from '../../proposals/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { proposalView } from '../proposals.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
const NOTES_MAX = 16 * 1024;
export const acceptBody = z.strictObject({ notes: z.string().trim().max(NOTES_MAX).optional() });
/** A rejection or a request for changes says why: the job and the trail are told. */
export const notesBody = z.strictObject({ notes: z.string().trim().min(1, 'say why').max(NOTES_MAX) });
/** Any part, or several; a part left out keeps its value. */
export const proposalSettingsBody = z.strictObject({
  reviewers: z.array(z.string().min(1)).max(16).optional(),
  signOff: z.enum(PROPOSAL_SIGN_OFF).optional(),
  levelRevisions: z.number().int().min(0).max(MAX_LEVEL_REVISIONS).optional(),
}).refine((b) => b.reviewers !== undefined || b.signOff !== undefined || b.levelRevisions !== undefined, { message: 'name reviewers, signOff or levelRevisions' });

const STATUS = { not_found: 404, not_open: 409 } as const;

export function registerProposalRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  /** Who decides: the person the session signed in. */
  const who = (req: FastifyRequest): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to decide on a proposal');
    return identityName(s.identity);
  };
  const answer = (req: FastifyRequest, r: ProposalActionResult) => {
    if (r.ok) return proposalView(o.tenant(req).store, r.proposal);
    throw new HttpError(STATUS[r.reason], r.message);
  };
  const id = (req: FastifyRequest) => parseWith(idParams, req.params).id;
  app.post('/ui/api/proposals/:id/accept', o.operator, async (req) =>
    answer(req, o.tenant(req).proposals.accept(id(req), who(req), parseWith(acceptBody, req.body ?? {}).notes || undefined)));
  app.post('/ui/api/proposals/:id/reject', o.operator, async (req) =>
    answer(req, o.tenant(req).proposals.reject(id(req), who(req), parseWith(notesBody, req.body ?? {}).notes)));
  app.post('/ui/api/proposals/:id/request-changes', o.operator, async (req) =>
    answer(req, o.tenant(req).proposals.requestChanges(id(req), who(req), parseWith(notesBody, req.body ?? {}).notes)));
  app.post('/ui/api/proposals/:id/seen', o.operator, async (req) => answer(req, o.tenant(req).proposals.markSeen(id(req))));
  app.post('/ui/api/jobs/:id/propose', o.operator, async (req) => o.tenant(req).engine.askForProposal(id(req)));
  // Read at each review: applies without a restart.
  app.post('/ui/api/proposals/settings', o.admin, async (req) => {
    const t = o.tenant(req);
    const r = editProposalSettings(t.store, t.levelNames(), parseWith(proposalSettingsBody, req.body));
    if (!r.ok) throw new HttpError(400, r.error);
    return r.view;
  });
}
