// Settings → Push requirements (issue #2555, design.md "Push requirements"): the hopper's default requirements, which apply
// to every repository's push below its own requirements file — a requirement of the same id in the repository's file
// replaces the default. The same shape as a requirements file, sent as JSON. Read at each evaluation and each push, so a
// change applies without a restart. Least role to change: admin. The metrics (part 5): the CI runs the requirements caught on
// the job's machine, the billed minutes that saved, and the CI misses, from the events of the last `days` days.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pushRequirementMetrics, type CiMiss, type EvaluatedPush } from '../../domain/push-requirement-metrics.ts';
import { readRequirements, requirementsFileSchema, type PushRequirement } from '../../domain/push-requirements.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const DAY_MS = 86_400_000;
const metricsOf = (t: Pick<TenantParts, 'store'>, days: number) => {
  const events = t.store.events.between(['push_requirements.evaluated', 'push_requirements.ci_missed'], new Date(Date.now() - days * DAY_MS).toISOString());
  const evaluations = events.filter((e) => e.type === 'push_requirements.evaluated').map((e) => ({ ...(e.data as unknown as EvaluatedPush), at: e.at }));
  const misses = events.filter((e) => e.type === 'push_requirements.ci_missed').map((e) => e.data as unknown as CiMiss);
  return { days, ...pushRequirementMetrics(evaluations, misses) };
};

const defaultsOf = (t: Pick<TenantParts, 'store'>): { requirements: PushRequirement[] } => ({ requirements: t.store.settings.getPushRequirementDefaults() });

export const PUSH_REQUIREMENT_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/push-requirements', tag: 'Jobs', summary: 'The default push requirements', description: 'Issue #2555: the hopper\'s default push requirements, as a requirements file holds them. They apply to every repository\'s push, below the repository\'s own `.hopper/requirements.yaml`. None by default.', returns: '`{ requirements: PushRequirement[] }`' },
  { method: 'get', path: '/api/push-requirements/metrics', tag: 'Jobs', summary: 'What the push requirements caught and missed', description: 'Issue #2555 part 5: of the last `days` days (default 30, at most 365), `caught`: the commits whose newest evaluation failed on a check that names the CI check it stands for (`ci`), each a CI run kept off CI; `minutesSaved`: the billed minutes those checks name for such a run; `unpriced`: the runs caught whose checks name no minutes; `missed`: the CI runs of a job\'s pull request that failed on a check a requirement that applied stands for (`push_requirements.ci_missed`); `minutesMissed`: their billed minutes. `repos`: the same for each repository.', query: z.object({ days: z.string().optional() }), returns: '`{ days, caught, minutesSaved, unpriced, missed, minutesMissed, repos: [...] }`', errors: [400] },
  { method: 'post', path: '/ui/api/push-requirements', tag: 'Jobs', summary: 'Set the default push requirements', description: 'Recorded as `push_requirements.defaults_changed` when they change. The body is a requirements file\'s value: `{ requirements: [{ id, when, checks }] }`; an empty list is none. A requirement of the same id in a repository\'s file, a folder\'s or the job\'s replaces the default. Applies to the next evaluation and push, without a restart.', role: 'admin', body: requirementsFileSchema, returns: '`{ requirements: PushRequirement[] }`', errors: [400] },
];

export function registerPushRequirementRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/push-requirements', async (req) => defaultsOf(o.tenant(req)));
  app.get('/api/push-requirements/metrics', async (req) => {
    const raw = (req.query as { days?: string }).days;
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days is a whole number from 1 to 365');
    return metricsOf(o.tenant(req), days);
  });
  app.post('/ui/api/push-requirements', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the push requirements');
    const read = readRequirements(req.body);
    if (!read.ok) throw new HttpError(400, read.problem);
    const t = o.tenant(req);
    t.store.tx(() => {
      const from = t.store.settings.getPushRequirementDefaults();
      if (JSON.stringify(from) === JSON.stringify(read.requirements)) return;
      t.store.settings.setPushRequirementDefaults(read.requirements);
      t.store.events.append({ type: 'push_requirements.defaults_changed', data: { from: from.map((q) => q.id), to: read.requirements.map((q) => q.id), by: personOf(s) } });
    });
    return defaultsOf(t);
  });
}
