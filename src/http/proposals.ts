// Proposal routes (issue #537, design.md "Proposals"): list, and read with its versions and review trail, with the
// proposal settings and the escalation levels that may review. Apart from the questions. The open ones list
// high-priority jobs' first, then oldest first; every other listing is a history, newest first. A person's decision
// is a UI session mutation (src/http/ui/proposals.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserStore } from '../domain/ports.ts';
import { highFirst, jobPriorityTag, PROPOSAL_STATUSES, type Proposal, type ProposalView } from '../domain/types.ts';
import { proposalSettingsView } from '../proposals/index.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

/** `open`: open or being revised, so a decision is still to come. */
export const proposalsQuery = z.object({
  status: z.enum([...PROPOSAL_STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

/** The proposal with its job's live priority: 0 and not high when its job is gone. */
export function proposalView(store: UserStore, p: Proposal): ProposalView {
  return { ...p, ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), p.jobId) ?? { priority: 0, high: false }) };
}

export function proposalRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/proposals', async (req) => {
    const q = parseWith(proposalsQuery, req.query);
    const t = o.tenant(req);
    const open = q.status === 'open';
    const proposals = t.store.proposals.list({ ...(q.status === 'all' ? {} : { status: open ? ['open', 'revising'] : [q.status] }), limit: q.limit, order: open ? 'oldest-first' : 'newest-first' })
      .map((p) => proposalView(t.store, p));
    return { proposals: open ? highFirst(proposals, (p) => p.high) : proposals, settings: proposalSettingsView(t.store, t.levelNames()) };
  });

  app.get('/api/proposals/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { store } = o.tenant(req);
    const p = store.proposals.get(id);
    if (!p) throw new HttpError(404, `proposal ${id} not found`);
    return proposalView(store, p);
  });
}
