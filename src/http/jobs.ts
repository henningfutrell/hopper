import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import type { JobStatus } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';

const STATUSES = [
  'queued', 'held', 'claimed', 'running', 'waiting_answer', 'finished', 'failed', 'cancelled',
] as const satisfies JobStatus[];

const listQuery = z.object({
  status: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (!(STATUSES as readonly string[]).includes(p)) ctx.addIssue({ code: 'custom', message: `unknown status ${p}` });
    }
    return parts as JobStatus[];
  }),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const idParams = z.object({ id: z.string() });

// Read-only: jobs are pulled from sources, never posted (design.md "Phase 3").
export function jobRoutes(app: FastifyInstance, o: { store: Store }): void {
  const { store } = o;

  app.get('/api/jobs', async (req) => {
    const q = parseWith(listQuery, req.query);
    return { jobs: store.jobs.list({ ...(q.status ? { status: q.status } : {}), limit: q.limit }) };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const job = store.jobs.get(id);
    if (!job) throw new HttpError(404, `job ${id} not found`);
    return job;
  });
}
