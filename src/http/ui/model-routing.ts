// Model routing (issue #2848, design.md "Model routing"): which model and budget a new job gets from the class of its work,
// and whether a failed cheap job's item escalates to the strong model. An admin's; read at each intake, so a change applies
// to the next job without a restart. Read at GET /api/model-routing. Part 2: a person's job budget on one job, over its
// model route's and the user's caps (`POST /ui/api/jobs/:id/budget`, an operator's), read at its next checkpoint.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobBudgetBody, MODEL_ROUTING, modelRoutingOf, type JobBudget, type ModelRoutingSettings } from '../../domain/model-routing.ts';
import { TERMINAL_STATUSES } from '../../domain/types.ts';
import type { Clock } from '../../domain/ports.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const FIELDS = ['on', 'executors', 'cheap', 'strong', 'rules', 'repos', 'escalate', 'tune'] as const;

/** Any of the fields, each whole; one left out keeps its value. */
export const modelRoutingBody = MODEL_ROUTING.partial().refine((b) => FIELDS.some((k) => b[k] !== undefined), { message: `name one of ${FIELDS.join(', ')}` });

export const MODEL_ROUTING_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/model-routing', tag: 'Machines and usage', summary: 'Model routing', description: 'Issue #2848: which model a new job runs on, from the class of its work, and its budget. `on` (default off); `executors`: the executor instances whose jobs it routes (their agent takes the model names; default `herdr-claude`, `claude`). `cheap` and `strong`: each model choice\'s `model` (\'\': the agent\'s own default) and budget (`jobTokens`, `jobCostUsd`; 0: the token budget\'s job cap applies). At intake a job\'s work is classed — `size` (`small`: a `size:small` label, or a short text with few steps), `kind` (`code`, `research`, `proposal`, `tend`), `risk` (`high`: a risk label such as `security`, or a risky word in its title) and its repository —; a label `hopper:model-cheap` or `hopper:model-strong` picks the choice; else the first of `rules` (`name`, `match` on `repo` (a glob), `label`, `kind`, `size`, `risk`, and `choice`) that matches; else the strong model. `repos`: a repository\'s budget per choice, over the choice\'s own. `escalate` (default on): the next job of an item whose cheap job failed runs on the strong model, once (`job.model_escalated`), and the item stays there. `tune` (part 3, default off): grade history tunes a rule\'s choice — with `minSamples` graded jobs of each choice on the work\'s repository, else on its kind of work, a cheap choice goes strong when the strong model\'s mean is higher by more than `margin` points, and a low-risk strong choice goes cheap when the cheap model\'s is as high (`rule: grades`). The choice is kept on the job (`spec.modelRoute`); its budget pauses it as the token budget does, and so does a cheap job\'s stall (no progress, failing tests) while `escalate` is on.', returns: '`ModelRoutingSettings`' },
  { method: 'post', path: '/ui/api/jobs/:id/budget', tag: 'Jobs', summary: 'Set a job\'s own budget', description: 'Issue #2848, part 2: a person\'s job budget on one job that has not ended — `jobTokens`, `jobCostUsd`, either or both; one left out keeps its value, 0 takes that cap off — over its model route\'s budget and the token budget\'s job caps (`job.budget_set`). Read at the job\'s next checkpoint: over it, the job is paused as the token budget pauses it.', role: 'operator', body: jobBudgetBody, returns: 'the `Job`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/model-routing', tag: 'Machines and usage', summary: 'Change model routing', description: 'Any of the fields, each whole; one left out keeps its value (`model_routing.settings_changed`). Applies to the next job at intake, without a restart; a job routed already keeps its model and budget.', role: 'admin', body: modelRoutingBody, returns: '`ModelRoutingSettings`', errors: [400] },
];

export const modelRoutingView = (t: Pick<TenantParts, 'store'>): ModelRoutingSettings => modelRoutingOf(t.store.settings.getModelRouting());

const idParams = z.object({ id: z.string() });

export function registerModelRoutingRoutes(app: FastifyInstance, o: { admin: Guard; operator: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/model-routing', async (req) => modelRoutingView(o.tenant(req)));
  app.post('/ui/api/model-routing', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change model routing');
    const t = o.tenant(req);
    const patch = parseWith(modelRoutingBody, req.body);
    t.store.tx(() => {
      const from = modelRoutingView(t);
      const to: ModelRoutingSettings = { ...from, ...Object.fromEntries(FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) };
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setModelRouting(to);
      t.store.events.append({ type: 'model_routing.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return modelRoutingView(t);
  });
  app.post('/ui/api/jobs/:id/budget', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to set a job\'s budget');
    const { store } = o.tenant(req);
    const { id } = parseWith(idParams, req.params);
    const patch = parseWith(jobBudgetBody, req.body);
    return store.tx(() => {
      const job = store.jobs.get(id);
      if (!job) throw new HttpError(404, `job ${id} not found`);
      if (TERMINAL_STATUSES.includes(job.status)) throw new HttpError(409, `job ${id} is ${job.status}: only a job that has not ended takes a budget`);
      const from = job.jobBudget;
      const caps = { jobTokens: patch.jobTokens ?? from?.jobTokens ?? 0, jobCostUsd: patch.jobCostUsd ?? from?.jobCostUsd ?? 0 };
      if (from && from.jobTokens === caps.jobTokens && from.jobCostUsd === caps.jobCostUsd) return job;
      const by = personOf(s);
      const to: JobBudget = { ...caps, at: o.clock.now().toISOString(), by };
      store.events.append({ type: 'job.budget_set', jobId: id, data: { ...(from ? { from: { jobTokens: from.jobTokens, jobCostUsd: from.jobCostUsd } } : {}), to: caps, by } });
      return store.jobs.update(id, { jobBudget: to });
    });
  });
}
