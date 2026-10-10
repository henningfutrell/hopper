// Question routes (design.md "API additions"): list, and read with its escalation trail. The
// human answer is a UI session mutation (src/http/ui/). The open questions list oldest first, the
// longest waiting on top; every other listing is a history, newest first (issue #450). Each question carries its
// job's live priority and whether it is high priority; the open ones list high-priority ones first (issue #535). Each
// carries the forks made from it, with their review items (issue #570).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { UserStore } from '../domain/ports.ts';
import type { Engine } from '../engine/index.ts';
import { highFirst, jobPriorityTag, REVIEW_SECTIONS, type Question, type QuestionFork, type QuestionStatus, type QuestionView } from '../domain/types.ts';
import { forksOf, running } from '../questions/stale.ts';
import { tldrSettings, withShownTldr } from '../tldr/index.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

const STATUSES = ['open', 'answered', 'closed', 'dismissed', 'expired', 'lapsed', 'cancelled'] as const satisfies QuestionStatus[];

export const questionsQuery = z.object({
  status: z.enum([...STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

/** The forks made from the question (issue #570), oldest first: each one's job and, once it wrote one, its item. */
function questionForks(store: UserStore, q: Question): QuestionFork[] {
  return forksOf(store, q).map((f) => {
    const { kind, note } = f.forkOf!;
    const itemId = f[REVIEW_SECTIONS[kind].jobField];
    const item = itemId ? store.reviews[kind].get(itemId) : undefined;
    return { jobId: f.id, kind, ...(note ? { note } : {}), jobStatus: f.status, running: running(f), ...(item ? { itemId: item.id, itemStatus: item.status } : {}) };
  });
}

/**
 * The question with its job's live priority: 0 and not high when its job is gone; while it is open, the phase
 * shifts it offers now (issue #548), so the UI offers only what the server takes; and the forks made from it (issue #570).
 */
export function questionView(t: { store: UserStore; engine: Pick<Engine, 'phaseShifts'> }, q: Question): QuestionView {
  const { store } = t;
  const forks = questionForks(store, q);
  return {
    // Its TL;DR (issue #569) only while it is shown: written from the text as it is, the setting on.
    ...withShownTldr('question', q, tldrSettings(store)), ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId) ?? { priority: 0, high: false }),
    ...(q.status === 'open' ? { shifts: t.engine.phaseShifts.offered(q) } : {}),
    ...(forks.length > 0 ? { forks } : {}),
  };
}

export function questionRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/questions', async (req) => {
    const q = parseWith(questionsQuery, req.query);
    const t = o.tenant(req);
    const questions = t.store.questions.list({ ...(q.status === 'all' ? {} : { status: [q.status] }), limit: q.limit, order: q.status === 'open' ? 'oldest-first' : 'newest-first' })
      .map((x) => questionView(t, x));
    return { questions: q.status === 'open' ? highFirst(questions, (x) => x.high) : questions };
  });

  app.get('/api/questions/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const t = o.tenant(req);
    const q = t.store.questions.get(id);
    if (!q) throw new HttpError(404, `question ${id} not found`);
    return questionView(t, q);
  });
}
