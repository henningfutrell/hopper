// The UI session's actions on failures (issue #509): resolve a problem, release its held jobs, run a surfaced
// failure's job again (operator); the failures settings and the known causes a person names (admin). Each refuses
// with the reason the Failures view reads from `actions`, so the view offers only what is taken.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FAILURE_DECISIONS, FAILURE_SETTING_BOUNDS } from '../../domain/types.ts';
import type { FailureAction } from '../../failures/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
const int = (k: keyof typeof FAILURE_SETTING_BOUNDS) => z.number().int().min(FAILURE_SETTING_BOUNDS[k].min).max(FAILURE_SETTING_BOUNDS[k].max).optional();
/** Any of the settings; one left out keeps its value. */
export const failureSettingsBody = z.strictObject({
  maxAttempts: int('maxAttempts'), backoffSec: int('backoffSec'),
  backoffFactor: z.number().min(FAILURE_SETTING_BOUNDS.backoffFactor.min).max(FAILURE_SETTING_BOUNDS.backoffFactor.max).optional(),
  backoffMaxSec: int('backoffMaxSec'), groupThreshold: int('groupThreshold'), groupWindowMin: int('groupWindowMin'), retentionDays: int('retentionDays'),
  auto: z.strictObject({ retry: z.boolean().optional(), hold: z.boolean().optional(), redirect: z.boolean().optional() }).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name at least one setting' });
const signature = z.string().regex(/^[0-9a-f]{12}$/, 'signature must be 12 hex digits');
export const failureCauseBody = z.strictObject({
  signature, name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(''), decision: z.enum(FAILURE_DECISIONS),
});
export const failureForgetBody = z.strictObject({ signature });

const STATUS = { not_found: 404, conflict: 409 } as const;

function answer<T>(r: FailureAction<T>): T {
  if (r.ok) return r.value;
  throw new HttpError(STATUS[r.reason], r.message);
}

export function registerFailureRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/failures/problems/:id/resolve', o.operator, async (req) => answer(o.tenant(req).failures.resolve(parseWith(idParams, req.params).id)));
  app.post('/ui/api/failures/problems/:id/release', o.operator, async (req) => answer(o.tenant(req).failures.release(parseWith(idParams, req.params).id)));
  app.post('/ui/api/failures/:id/retry', o.operator, async (req) => answer(await o.tenant(req).failures.retry(parseWith(idParams, req.params).id)));
  // Read at each assessment and sweep: applies without a restart.
  app.post('/ui/api/failures/settings', o.admin, async (req) => {
    const { auto, ...rest } = parseWith(failureSettingsBody, req.body);
    const f = o.tenant(req).failures;
    const was = f.settings().auto;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    return f.setSettings({ ...defined, ...(auto ? { auto: { ...was, ...Object.fromEntries(Object.entries(auto).filter(([, v]) => v !== undefined)) } } : {}) });
  });
  app.post('/ui/api/failures/causes', o.admin, async (req) => o.tenant(req).failures.nameCause(parseWith(failureCauseBody, req.body)));
  app.post('/ui/api/failures/causes/forget', o.admin, async (req) => {
    const { signature: s } = parseWith(failureForgetBody, req.body);
    if (!o.tenant(req).failures.forgetCause(s)) throw new HttpError(404, `no named cause for signature ${s}`);
    return { forgotten: s };
  });
}
