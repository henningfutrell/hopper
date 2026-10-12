// Infra (issue #870, design.md "Infra plans: no apply without a plan"): the plans the user's jobs recorded, each
// with its approval, and a person's approval of one. Approving a plan is a box action: it lets the vault mint a credential
// that changes infrastructure. Plans are never changed or removed here. The out-of-band changes (issue #871) register here too.
// An API token's approval of a plan that is not low risk is a person's to confirm (issue #909): asked, not done.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { planAsk, planNeedsPerson } from '../../domain/confirmation-asks.ts';
import { failedChecks } from '../../domain/infra-plans.ts';
import { isPlanRefusal } from '../../infra-plans/service.ts';
import { askerOf, askPerson, byApiToken, shownAsks } from './confirmation-asks.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';
import { OUT_OF_BAND_OPERATIONS, outOfBandReadRoutes, registerOutOfBandRoutes } from './out-of-band.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const infraPlanBody = z.strictObject({ action: z.literal('approve'), plan: z.string().max(64) });

export const INFRA_PLAN_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/infra-plans', tag: 'Infra', summary: 'Infra: the plans', description: 'Issue #870: the plans of infrastructure changes the user\'s jobs recorded, newest first, at most 200: each one\'s `tool` (terraform, helm, gitops), `asset` (what an apply of it is minted a credential for), `target`, `repo`, `ref`, `commit`, `pullRequest`, `read` (the read profile it was made with), `job`, `issue`, `file` (the saved plan file\'s size and SHA-256), `createdAt`, `expiresAt`, `summary` (what it changes in plain words, its `level`, its risk callouts, its blast radius and its checks), and `approval` once a person approved it; issue #909: `asked` (`asker`, `at`) while it waits, when an API token asked to approve it and a person is to confirm it. Never the text. Issue #896: `applies`, newest first, each credential the vault minted for one of these plans (`plan`, `at`, `operation`, `asset`, `job`, `expiresAt`, `renewal`), from its `vault.minted` event; never the credential. Not cached.', returns: '{ plans: PlanView[]; applies: PlanApply[] }' },
  { method: 'get', path: '/api/infra-plans/:id', tag: 'Infra', summary: 'Infra: one plan', description: 'Issue #870: one plan, with its `text`, and its `approval`. 404: no such plan. Not cached.', returns: '{ plan: InfraPlan & { approval? } }', errors: [404] },
  { method: 'post', path: '/ui/api/infra-plans', tag: 'Infra', summary: 'Approve a plan', description: 'Issue #870: `action` `approve`, `plan` its id. Kept as a row of its own (`infra.plan_approved`, on the timeline of the job that recorded it); the plan does not change. Until the plan is stale, an ask for a credential that changes infrastructure that names it, made at the commit its branch is at, is minted. 404: no such plan; 409: approved already, or the plan failed a check (a new AWS resource without the MAP tag). A box action. Issue #909: for an API token, a plan that is not low risk is not approved: 202 `{ waiting }`, and a person is asked (`approval.confirmation_asked`, once an hour at most), who approves it in the UI.', role: 'admin', body: infraPlanBody, returns: '{ plan: PlanView } | { waiting: string }', errors: [400, 404, 409] },
  ...OUT_OF_BAND_OPERATIONS,
];

export function infraPlanReadRoutes(app: FastifyInstance, { tenant }: { tenant: (req: FastifyRequest) => TenantParts }): void {
  outOfBandReadRoutes(app, { tenant });
  app.get('/api/infra-plans', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const infra = tenant(req).githubProxy.infraPlans;
    const listed = infra.list();
    const asked = shownAsks(tenant(req).store, 'infra-plan');
    const plans = listed.map((p) => {
      const a = p.approval ? undefined : asked.get(p.id);
      return a ? { ...p, asked: a } : p;
    });
    return { plans, applies: infra.applies(listed) };
  });
  app.get<{ Params: { id: string } }>('/api/infra-plans/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const plans = tenant(req).githubProxy.infraPlans;
    const plan = plans.get(req.params.id);
    if (!plan) throw new HttpError(404, `no plan ${req.params.id}`);
    const approval = plans.approval(plan.id);
    return { plan: { ...plan, ...(approval ? { approval } : {}) } };
  });
}

export function registerInfraPlanRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  registerOutOfBandRoutes(app, o);
  app.post('/ui/api/infra-plans', o.admin, async (req, reply) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to approve a plan');
    const b = parseWith(infraPlanBody, req.body);
    const parts = o.tenant(req);
    const infra = parts.githubProxy.infraPlans;
    const plan = infra.get(b.plan);
    if (byApiToken(s) && plan && !infra.approval(plan.id) && !failedChecks(plan) && planNeedsPerson(plan)) {
      return askPerson(parts.store, reply, planAsk(plan, askerOf(s)), plan.job);
    }
    const r = infra.approve(b.plan, identityName(s.identity));
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { plan: r };
  });
}
