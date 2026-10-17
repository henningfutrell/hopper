// Settings → Intake, intake strictness (issue #655 part 3, brake 1, design.md "Trust stamps"): the trust level a job's
// stamp needs before the job starts — by default, per job source and per job repository. Standard by default. Read at
// each Decision, so a change applies at the next one. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_INTAKE_STRICTNESS, INTAKE_STRICTNESS, type IntakeStrictness } from '../../domain/intake-strictness.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const strictness = z.enum(INTAKE_STRICTNESS);
const source = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'a job source\'s name');
const repo = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'a repository as owner/name');
export const intakeStrictnessBody = z.strictObject({
  default: strictness,
  sources: z.record(source, strictness).refine((r) => Object.keys(r).length <= 200, 'at most 200 sources'),
  repos: z.record(repo, strictness).refine((r) => Object.keys(r).length <= 200, 'at most 200 repositories'),
});

const settingsOf = (t: Pick<TenantParts, 'store'>): IntakeStrictness => t.store.settings.getIntakeStrictness() ?? DEFAULT_INTAKE_STRICTNESS;

/** Keys sorted, repositories lowercased: one setting has one form, so an unchanged save records nothing. */
const sorted = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const SHAPE = '`{ default: Strictness, sources: { [source]: Strictness }, repos: { ["owner/name"]: Strictness } }`, Strictness `open` | `standard` | `strict` | `closed`';

export const INTAKE_STRICTNESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/intake-strictness', tag: 'Jobs', summary: 'Intake strictness', description: 'Issue #655 (brake 1): the trust level a job\'s stamp needs before the job starts. `open`: `screened` or above; `standard` (the default): `approved` or above; `strict`: `trusted` or above; `closed`: only `owner`. The job\'s repository wins over its source, and its source over `default`. A job held by it says so in its hold reason.', returns: SHAPE },
  { method: 'post', path: '/ui/api/intake-strictness', tag: 'Jobs', summary: 'Set intake strictness', description: 'Issue #655: the whole setting. Repositories are kept lowercased. Recorded as `intake.strictness_changed` when it changes. Applies at the next Decision, to waiting jobs; a running job keeps going.', role: 'admin', body: intakeStrictnessBody, returns: SHAPE, errors: [400] },
];

export function registerIntakeStrictnessRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/intake-strictness', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/intake-strictness', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the intake strictness');
    const t = o.tenant(req);
    const body = parseWith(intakeStrictnessBody, req.body);
    const to: IntakeStrictness = {
      default: body.default,
      sources: sorted(body.sources),
      repos: sorted(Object.fromEntries(Object.entries(body.repos).map(([r, v]) => [r.toLowerCase(), v]))),
    };
    t.store.tx(() => {
      const from = settingsOf(t);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setIntakeStrictness(to);
      t.store.events.append({ type: 'intake.strictness_changed', data: { from, to, by: personOf(s) } });
    });
    return settingsOf(t);
  });
}
