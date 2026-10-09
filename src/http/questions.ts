// Question routes (design.md "API additions"): list, and read with its escalation trail. The
// human answer is a UI session mutation (src/http/ui/). The open questions list oldest first, the
// longest waiting on top; every other listing is a history, newest first (issue #450). Each question carries its
// job's live priority and whether it is high priority; the open ones list high-priority ones first (issue #535).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { UserStore } from '../domain/ports.ts';
import { highFirst, jobPriorityTag, type Question, type QuestionStatus, type QuestionView } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

const STATUSES = ['open', 'answered', 'closed', 'dismissed', 'expired', 'lapsed', 'cancelled'] as const satisfies QuestionStatus[];

export const questionsQuery = z.object({
  status: z.enum([...STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

/** The question with its job's live priority: 0 and not high when its job is gone. */
export function questionView(store: UserStore, q: Question): QuestionView {
  return { ...q, ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId) ?? { priority: 0, high: false }) };
}

export function questionRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/questions', async (req) => {
    const q = parseWith(questionsQuery, req.query);
    const { store } = o.tenant(req);
    const questions = store.questions.list({ ...(q.status === 'all' ? {} : { status: [q.status] }), limit: q.limit, order: q.status === 'open' ? 'oldest-first' : 'newest-first' })
      .map((x) => questionView(store, x));
    return { questions: q.status === 'open' ? highFirst(questions, (x) => x.high) : questions };
  });

  app.get('/api/questions/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { store } = o.tenant(req);
    const q = store.questions.get(id);
    if (!q) throw new HttpError(404, `question ${id} not found`);
    return questionView(store, q);
  });
}
