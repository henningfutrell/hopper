import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withPhase, type JobStatus } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

const STATUSES = [
  'queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'parked', 'waiting_on', 'finished', 'failed', 'cancelled', 'rejected',
] as const satisfies JobStatus[];

export const jobsQuery = z.object({
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

// Read-only: jobs are pulled from sources, never posted (design.md "Phase 3"). The request's user's jobs, each with its phase (issue #548).
export function jobRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/jobs', async (req) => {
    const q = parseWith(jobsQuery, req.query);
    return { jobs: o.tenant(req).store.jobs.list({ ...(q.status ? { status: q.status } : {}), limit: q.limit }).map(withPhase) };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const job = o.tenant(req).store.jobs.get(id);
    if (!job) throw new HttpError(404, `job ${id} not found`);
    return withPhase(job);
  });
}
