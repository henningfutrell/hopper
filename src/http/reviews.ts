// Review section routes (issues #537, #543, design.md "Sections"): for each review section — Proposals, Research — list,
// and read one with its versions and review trail, with the section's settings, the escalation levels that may
// review, and its type: the parts and the decisions the server takes, so the UI offers exactly those. The open ones
// list high-priority jobs' first, then oldest first; every other listing is a history, newest first. A person's
// decision is a UI session mutation (src/http/ui/reviews.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserStore } from '../domain/ports.ts';
import { highFirst, jobPriorityTag, thenChoices, REVIEW_KINDS, REVIEW_OPEN_STATUSES, REVIEW_SECTIONS, REVIEW_STATUSES, reviewSectionView, type ReviewItem, type ReviewItemView } from '../domain/types.ts';
import { reviewSettingsView } from '../review/index.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

/** `open`: open or being revised, so a decision is still to come. */
export const reviewQuery = z.object({
  status: z.enum([...REVIEW_STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

/**
 * The item with its job's live priority: 0 and not high when its job is gone. While it is open and its job is in a
 * phase a question switched it to (issue #548), `then`: what a person may pick for the job at Accept.
 */
export function reviewItemView(store: UserStore, p: ReviewItem): ReviewItemView {
  const switched = p.status === 'open' && store.jobs.get(p.jobId)?.shift?.to === p.kind;
  return { ...p, ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), p.jobId) ?? { priority: 0, high: false }), ...(switched ? { then: thenChoices(p.kind) } : {}) };
}

export function reviewRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  for (const kind of REVIEW_KINDS) {
    const { section, noun } = REVIEW_SECTIONS[kind];
    app.get(`/api/${section}`, async (req) => {
      const q = parseWith(reviewQuery, req.query);
      const t = o.tenant(req);
      const open = q.status === 'open';
      const items = t.store.reviews[kind].list({ ...(q.status === 'all' ? {} : { status: open ? [...REVIEW_OPEN_STATUSES] : [q.status] }), limit: q.limit, order: open ? 'oldest-first' : 'newest-first' })
        .map((p) => reviewItemView(t.store, p));
      return { items: open ? highFirst(items, (p) => p.high) : items, settings: reviewSettingsView(t.store, kind, t.levelNames()), type: reviewSectionView(kind) };
    });

    app.get(`/api/${section}/:id`, async (req) => {
      const { id } = parseWith(idParams, req.params);
      const { store } = o.tenant(req);
      const p = store.reviews[kind].get(id);
      if (!p) throw new HttpError(404, `${noun} ${id} not found`);
      return reviewItemView(store, p);
    });
  }
}
