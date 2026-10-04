// Question routes (design.md "API additions"): list, and read with its escalation trail. The
// human answer is a UI session mutation (src/http/ui/).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import type { QuestionStatus } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';

const STATUSES = ['open', 'answered', 'closed', 'expired', 'cancelled'] as const satisfies QuestionStatus[];

const listQuery = z.object({
  status: z.enum([...STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });

export function questionRoutes(app: FastifyInstance, o: { store: Store }): void {
  const { store } = o;

  app.get('/api/questions', async (req) => {
    const q = parseWith(listQuery, req.query);
    return { questions: store.questions.list({ ...(q.status === 'all' ? {} : { status: [q.status] }), limit: q.limit }) };
  });

  app.get('/api/questions/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const q = store.questions.get(id);
    if (!q) throw new HttpError(404, `question ${id} not found`);
    return q;
  });
}
