// Infra (issue #870, design.md "Infra plans: no apply without a plan"): the plans the user's jobs recorded, each
// with its approval and who may approve it, and a person's approval of one. Approving a plan is a box action: it lets the
// vault mint a credential that changes infrastructure. By risk (part 3): an operator approves a low-risk uat plan, an
// admin any other; the service checks the role, so the route's least role is operator. Auto-approve (admin) lets the
// hopper approve a low-risk uat plan when it is kept. Plans are never changed or removed here. The out-of-band changes
// (issue #871) and the infrastructure topology (issue #1781) register here too. An admin names the environment watchers (part 4), whom the notifiers name.
// An API token's approval of a plan that is not low risk is a person's to confirm (issue #909): asked, not done. A person
// rejects a plan (issue #2368), with a note: terminal, the same route, an operator's.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { planAsk, planNeedsPerson } from '../../domain/confirmation-asks.ts';
import { approveRefusal, REJECTION_NOTE_MAX } from '../../domain/infra-plans.ts';
import { isPlanRefusal } from '../../infra-plans/service.ts';
import { askerOf, askPerson, byApiToken, shownAsks } from './confirmation-asks.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';
import { OUT_OF_BAND_OPERATIONS, outOfBandReadRoutes, registerOutOfBandRoutes } from './out-of-band.ts';
import { registerTopologyRoutes, TOPOLOGY_OPERATIONS, topologyReadRoutes } from './topology.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const infraPlanBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), plan: z.string().max(64) }),
  // Issue #2368: a person rejects the plan, saying why.
  z.strictObject({ action: z.literal('reject'), plan: z.string().max(64), note: z.string().max(REJECTION_NOTE_MAX) }),
]);
export const infraPlanSettingsBody = z.strictObject({ autoApprove: z.boolean() });
export const infraWatchersBody = z.strictObject({ watchers: z.record(z.string().max(20), z.array(z.string().max(200)).max(100)) });

export const INFRA_PLAN_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/infra-plans', tag: 'Infra', summary: 'Infra: the plans', description: 'Issue #870: the plans of infrastructure changes the user\'s jobs recorded, newest first, at most 200: each one\'s `tool` (terraform, helm, gitops), `asset` (what an apply of it is minted a credential for), `target`, `repo`, `ref`, `commit`, `pullRequest`, `read` (the read profile it was made with), `job`, `issue`, `file` (the saved plan file\'s size and SHA-256), `createdAt`, `expiresAt`, `summary` (what it changes in plain words, its `level`, its risk callouts, its blast radius and its checks), `approver` (`who` approves it — `operator`, `admin` or `nobody` — and `why`, by its risk), and `approval` once approved (`auto` when the hopper approved it); issue #909: `asked` (`asker`, `at`) while it waits, when an API token asked to approve it and a person is to confirm it. Never the text. Issue #896: `applies`, newest first, each credential the vault minted for one of these plans (`plan`, `at`, `operation`, `asset`, `job`, `expiresAt`, `renewal`, and since issue #2206 `actions`: the granted AWS actions it was narrowed to), from its `vault.minted` event; never the credential. `settings`: `autoApprove`. Part 4: `watchers`, the environment watchers. Not cached.', returns: '{ plans: PlanView[]; applies: PlanApply[]; settings: { autoApprove: boolean }; watchers: Record<string, string[]> }' },
  { method: 'get', path: '/api/infra-plans/:id', tag: 'Infra', summary: 'Infra: one plan', description: 'Issue #870: one plan, with its `text`, its `approver` and its `approval`. 404: no such plan. Not cached.', returns: '{ plan: InfraPlan & { approval? } }', errors: [404] },
  { method: 'post', path: '/ui/api/infra-plans', tag: 'Infra', summary: 'Approve or reject a plan', description: 'Issue #870: `action` `approve`, `plan` its id. Kept as a row of its own (`infra.plan_approved`, on the timeline of the job that recorded it); the plan does not change. Until the plan is stale, an ask for a credential that changes infrastructure that names it, made at the commit its branch is at, is minted. By risk: an operator approves a low-risk plan in uat only; any other plan only an admin (403 otherwise, saying why). 404: no such plan; 409: approved already, or the plan failed a check (a new AWS resource without the MAP tag). A box action. Issue #909: for an API token whose role may approve it, a plan that is not low risk is not approved: 202 `{ waiting }`, and a person is asked (`approval.confirmation_asked`, once an hour at most), who approves it in the UI. Issue #2368: `action` `reject`, `plan` its id, `note` why (1 to 1000 characters): kept as a row of its own (`infra.plan_rejected`, who, when and the note), terminal: the plan is never approved after (409), and the vault mints nothing for it. A job that waits on it is woken with the note. 400: no note; 409: approved or rejected already. Any operator or admin rejects any plan.', role: 'operator', body: infraPlanBody, returns: '{ plan: PlanView } | { waiting: string }', errors: [400, 403, 404, 409] },
  { method: 'post', path: '/ui/api/infra-plans/settings', tag: 'Infra', summary: 'Auto-approve low-risk uat plans', description: 'Issue #870: `autoApprove` on: the hopper approves a plan an operator may approve (low risk, in uat only) when the job records it; the approval names the hopper (`auto`), and it is shown and on the timeline as any other. Off, the default: a person approves each plan. Recorded as `infra.settings_changed` when it changes. A box action: it approves work.', role: 'admin', body: infraPlanSettingsBody, returns: '{ settings: { autoApprove: boolean } }', errors: [400] },
  { method: 'post', path: '/ui/api/infra-plans/watchers', tag: 'Infra', summary: 'Name the environment watchers', description: 'Issue #870 part 4: `watchers`, the whole list: for each environment (`prod`, `uat`, `staging`, `dev`, `qa`), and for every plan (`*`), the names the notifiers\' receiver tells of each plan, approval and apply there (a handle, a team, a channel; one line, no comma, at most 50 an environment). A plan names the watchers of `*` and of each environment it names. Kept trimmed, each name once; an environment with no name is dropped. `infra.watchers_changed` when it changes. 400: an environment the hopper does not know, or a name that is not one line.', role: 'admin', body: infraWatchersBody, returns: '{ watchers: Record<string, string[]> }', errors: [400] },
  ...OUT_OF_BAND_OPERATIONS, ...TOPOLOGY_OPERATIONS,
];

export function infraPlanReadRoutes(app: FastifyInstance, { tenant }: { tenant: (req: FastifyRequest) => TenantParts }): void {
  outOfBandReadRoutes(app, { tenant }); topologyReadRoutes(app, { tenant });
  app.get('/api/infra-plans', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const infra = tenant(req).githubProxy.infraPlans;
    const listed = infra.list();
    const asked = shownAsks(tenant(req).store, 'infra-plan');
    const plans = listed.map((p) => {
      const a = p.approval ? undefined : asked.get(p.id);
      return a ? { ...p, asked: a } : p;
    });
    return { plans, applies: infra.applies(listed), settings: infra.settings(), watchers: infra.watchers() };
  });
  app.get<{ Params: { id: string } }>('/api/infra-plans/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const plan = tenant(req).githubProxy.infraPlans.view(req.params.id);
    if (!plan) throw new HttpError(404, `no plan ${req.params.id}`);
    return { plan };
  });
}

export function registerInfraPlanRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  registerOutOfBandRoutes(app, o); registerTopologyRoutes(app, o);
  app.post('/ui/api/infra-plans', o.operator, async (req, reply) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to approve a plan');
    const b = parseWith(infraPlanBody, req.body);
    const parts = o.tenant(req);
    const infra = parts.githubProxy.infraPlans;
    if (b.action === 'reject') {
      const r = infra.reject(b.plan, personOf(s), b.note);
      if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
      return { plan: r };
    }
    const plan = infra.get(b.plan);
    // Only a token whose role may approve the plan asks a person; any other gets the approve's own refusal.
    if (byApiToken(s) && plan && !infra.approval(plan.id) && !approveRefusal(plan, s.role) && planNeedsPerson(plan)) {
      return askPerson(parts.store, reply, planAsk(plan, askerOf(s)), plan.job);
    }
    const r = infra.approve(b.plan, personOf(s), s.role);
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { plan: r };
  });
  app.post('/ui/api/infra-plans/settings', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change auto-approve');
    const b = parseWith(infraPlanSettingsBody, req.body);
    return { settings: o.tenant(req).githubProxy.infraPlans.setSettings(b, personOf(s)) };
  });
  app.post('/ui/api/infra-plans/watchers', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to name the environment watchers');
    const b = parseWith(infraWatchersBody, req.body);
    const r = o.tenant(req).githubProxy.infraPlans.setWatchers(b.watchers, personOf(s));
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { watchers: r };
  });
}
