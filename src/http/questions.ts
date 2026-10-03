// Question routes (design.md "API additions"): list, read with its escalation trail, and the
// human answer, which the QuestionService applies compare-and-set.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QuestionService, Store } from '../domain/ports.ts';
import type { QuestionStatus } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';

const STATUSES = ['open', 'answered', 'expired', 'cancelled'] as const satisfies QuestionStatus[];

const listQuery = z.object({
  status: z.enum([...STATUSES, 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const idParams = z.object({ id: z.string() });
const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });

export function questionRoutes(app: FastifyInstance, o: { store: Store; questions: QuestionService }): void {
  const { store, questions } = o;

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

  app.post('/api/questions/:id/answer', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const r = questions.answerByHuman(id, answer);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });
}
