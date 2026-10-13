// The shared rate limiter (issue #436, design.md "The shared rate limiter"): GET /api/github-rate-limiter shows its
// settings, what GitHub last told of each rate-limit bucket, the conditional requests' cache and the waits; the
// hopper's admin changes the settings (POST /ui/api/github-rate-limiter), and they apply at once, without a restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RATE_LIMITER_RANGES, type RateLimiterView } from '../../domain/github-rate-limit.ts';
import type { RateLimiterControl } from '../../github-limiter/settings.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const whole = (k: keyof typeof RATE_LIMITER_RANGES) => z.number().int().min(RATE_LIMITER_RANGES[k].min).max(RATE_LIMITER_RANGES[k].max).optional();
/** Any of the settings; one left out keeps its value. */
export const rateLimiterBody = z.strictObject({ slowBelowPercent: whole('slowBelowPercent'), reserve: whole('reserve'), batchSize: whole('batchSize'), intakeReserve: whole('intakeReserve') })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name slowBelowPercent, reserve, batchSize or intakeReserve' });

export const RATE_LIMITER_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/github-rate-limiter', tag: 'Jobs', summary: 'The shared GitHub rate limiter', description: 'Issue #436: one limiter for every GitHub call and GitHub watch. `settings`: below `slowBelowPercent` of a rate limit, the calls left above `reserve` are spread evenly to its reset; at `reserve`, calls wait for the reset; GitHub watches poll in batches of `batchSize`, spread across their interval; at `intakeReserve` or below, intake — the reads that look for new jobs — waits for the reset, so a job\'s own calls still go (issue #983). `buckets`: what GitHub last told of each credential\'s rate limit per resource (`limit`, `remaining`, `resetAt` in ms; `holdUntil` after GitHub refused a call for its rate), the fewest left first; no credential is named. `cache`: conditional requests (ETag): answers kept, `hits` (304: no call spent), `misses`. `waits`: calls the limiter made wait, and for how long in all.', returns: '`RateLimiterView`' },
  { method: 'post', path: '/ui/api/github-rate-limiter', tag: 'Jobs', summary: 'Change the shared GitHub rate limiter', description: 'Only the instance admin (issue #436). Any of `slowBelowPercent` (0–100), `reserve` (0–5000), `batchSize` (1–100), `intakeReserve` (0–5000), whole numbers; one left out keeps its value. Applies to the next call and the next poll round, without a restart; a change is `github_rate_limiter.settings_changed`.', role: 'admin', body: rateLimiterBody, returns: '`RateLimiterView`', errors: [400] },
];

export function registerRateLimiterRoutes(app: FastifyInstance, o: { instance: Guard; rateLimiter: RateLimiterControl; by: (req: FastifyRequest) => string }): void {
  app.get('/api/github-rate-limiter', async (): Promise<RateLimiterView> => o.rateLimiter.view());
  app.post('/ui/api/github-rate-limiter', o.instance, async (req): Promise<RateLimiterView> => {
    const body = parseWith(rateLimiterBody, req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return o.rateLimiter.change(patch, o.by(req));
  });
}
