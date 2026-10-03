import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import type { JobSpec, JobStatus } from '../domain/types.ts';
import type { Engine } from '../engine/index.ts';
import { HttpError, parseWith } from './errors.ts';

const STATUSES = [
  'queued', 'held', 'claimed', 'running', 'waiting_answer', 'finished', 'failed', 'cancelled',
] as const satisfies JobStatus[];

const jobSpec = z.object({
  executor: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().finite().optional(),
  goal: z.string().optional(),
  kind: z.string().optional(),
  submittedBy: z.string().optional(),
  machineId: z.string().min(1).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

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

export function jobRoutes(app: FastifyInstance, o: { engine: Engine; store: Store }): void {
  const { engine, store } = o;

  app.post('/api/jobs', async (req, reply) => {
    const spec = parseWith(jobSpec, req.body) as JobSpec;
    return reply.code(201).send(engine.pushJob(spec));
  });

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

  app.post('/api/jobs/:id/cancel', async (req) => engine.cancel(parseWith(idParams, req.params).id));
  app.post('/api/jobs/:id/approve', async (req) => engine.approve(parseWith(idParams, req.params).id));
}
