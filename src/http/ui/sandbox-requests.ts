// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): a person approves or declines a job's sandbox
// request on Access requests, and an admin sets the two toggles that skip a person — skip template approval, skip
// sandbox approval — or sandbox YOLO, both. Both are box actions: approving a request starts a box, and the toggles
// approve work with no person. Each answers the vault's view, which carries the requests and the toggles. A decline is a
// person's deny at gate 2 (issue #655, part 5): the job's trust one level lower, the second quarantines it.
// Issue #2197: a run card is approved or declined once (`approve-run`, `decline-run`, by job and template): the template
// as it is, each write, sync or apply profile it lists, and the job's run. Part 3: for this job's runs only, unless the
// person allows it again: then for every job, and each write approval is remembered, as a person's approve-profile is.
// Issue #2206: a person grants or declines a job's ask for an AWS action (`grant-action`, `decline-action`), and revokes
// a grant (`revokeAction` on the sandbox approvals). A person's act only: an API token is refused. The job's asks on its
// run card are granted by its `approve-run` and declined by its `decline-run`, so a person decides the card once.
// Issue #2639 part 3: a card that carries the job's vault grant (`vaultGrant`) grants it with its `approve-run`, after
// Access (`vault_grant#can_grant`), as Grant on a grant ask would: template, run and grant are one decision.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { ACCESS_UNAVAILABLE, ASSET_KINDS } from '../../domain/access.ts';
import { profileAsk, profileNeedsPerson } from '../../domain/confirmation-asks.ts';
import { actionsOf } from '../../domain/action-grants.ts';
import { forgetting, rememberApproval, REMEMBER_HOURS_MAX } from '../../domain/remembered-writes.ts';
import { approvalsOf, type RunCardView } from '../../domain/run-cards.ts';
import { autoApproveOf, editedApprovals, NO_SKIPS } from '../../domain/sandbox-approvals.ts';
import { grantKeyOf } from '../../domain/vault-grants.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import type { TemplateView } from '../../domain/vault.ts';
import { vaultAnswer } from '../vault.ts';
import { templateNames } from '../../domain/delegates.ts';
import type { ApiGrants } from './api-grants.ts';
import { askerOf, askPerson, byApiToken } from './confirmation-asks.ts';
import { approverOf, delegateOf, refuseDenied } from './delegates.ts';
import { actingOf, personOf } from './sessions.ts';
import { actionAsks, declineAction, grantAction, revokeAction, type ActionScope } from '../../vault/action-grants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** An action grant's scope (issue #2206): the aws-role (`<account>/<role>`), the AWS action and its resource's ARN. */
const actionScope = z.strictObject({ role: z.string().regex(/^\d{12}\/[\w+=,.@-]{1,64}$/), action: z.string().max(200), resource: z.string().max(1100) });

export const sandboxRequestBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), id: z.string().max(64) }),
  z.strictObject({ action: z.literal('decline'), id: z.string().max(64), reason: z.string().trim().min(1).max(500) }),
  // Issue #2197 part 3: `allowAgain`: the approval is for every job's runs, and a write approval is remembered; absent, this job's only.
  z.strictObject({ action: z.literal('approve-run'), job: z.string().max(64), template: z.string().max(64), allowAgain: z.boolean().optional() }),
  z.strictObject({ action: z.literal('decline-run'), job: z.string().max(64), template: z.string().max(64), reason: z.string().trim().min(1).max(500) }),
  // Issue #2206: a job's ask for an AWS action, by its job and scope.
  z.strictObject({ action: z.literal('grant-action'), job: z.string().max(64), grant: actionScope }),
  z.strictObject({ action: z.literal('decline-action'), job: z.string().max(64), grant: actionScope, reason: z.string().trim().max(500).optional() }),
]);
type RunEdit = Extract<z.infer<typeof sandboxRequestBody>, { action: 'approve-run' | 'decline-run' }>;
export const sandboxApprovalsBody = z.strictObject({
  yolo: z.boolean().optional(), skipTemplateApproval: z.boolean().optional(), skipSandboxApproval: z.boolean().optional(),
  // Issue #1001: the auto-approve policy; each level named sets itself.
  autoApprove: z.strictObject({ low: z.boolean().optional(), medium: z.boolean().optional(), high: z.boolean().optional() }).optional(),
  // Issue #1001: how long a person's write approval is remembered (0: until forgotten), and one to forget now.
  rememberWritesHours: z.number().int().min(0).max(REMEMBER_HOURS_MAX).optional(),
  // Issue #1472: the standing read grant.
  standingReadGrant: z.boolean().optional(),
  forgetWrite: z.strictObject({ operation: z.enum(['write', 'sync', 'apply', 'observe']), asset: z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) }) }).optional(),
  // Issue #2206: revoke one action grant now.
  revokeAction: actionScope.optional(),
});

const STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

export const SANDBOX_REQUEST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/sandbox-requests', tag: 'Vault', summary: 'Approve or decline a job\'s sandbox request', description: 'Issue #991: a running job asks for sandbox runs of the template its needs make (`sh "$HOPPER_SKILL" sandbox --needs …`); unless skip sandbox approval is on, the auto-approve policy holds the template\'s blast radius, or a person approved the template this job asked for (issue #1001), the request waits here (the vault\'s view lists it in `sandboxRequests`). `approve` (`id`) approves the job\'s sandbox runs (`vault.sandbox_approved`): it starts no box, and each of the job\'s box steps then runs in a sandbox of its own, burned after it (issue #1349); `decline` (`id`, `reason`) tells the job no (`vault.sandbox_declined`), and is a person\'s deny at gate 2 (issue #655 part 5): the job\'s trust stamp one level lower (`job.trust_lowered`), and the second decline in the job quarantines it (`job.quarantined`, its proxy token then opens no door of the hopper). Part 13: a request Jev\'s sandbox check holds (`jev`) waits here too; one Jev reads now (`jev.state` `checking`) can still be decided, and the person\'s answer wins. Each on the job\'s timeline. 404: no such request; 409: it does not wait. Issue #2197: a run card (`runs` in the vault\'s view, one per job and template that waits for a person) is decided once. `approve-run` (`job`, `template`) approves the template as it is when it waits (`vault.approved`: its image, tools, egress, secrets and read profiles), each write, sync or apply profile it lists (`template.profile_approved`, remembered as a person\'s approval), and the job\'s waiting run (`vault.sandbox_approved`); the job\'s step then goes on with no other approval. Issue #2639 part 3: a card with `vaultGrant` (its template gives a vault secret or a minted credential, and the job\'s item has no vault grant) also grants the job\'s item the vault (`vault.granted`), after Access (`vault_grant#can_grant`, 403; 503 when it cannot be asked), so template, run and grant are one approval; the job\'s grant ask of that template is on the card, not in `grantAsks`. Part 3: with no `allowAgain`, the template\'s approval is for this job\'s runs only (`approval.jobs`), so another job that asks for the same access gets a run card of its own, and no write approval is remembered; `allowAgain: true` approves it for every job, as a person\'s template approval, and remembers each write approval. An API token\'s `approve-run` of a card that lists a write, sync or apply profile is a person\'s to confirm: 202, asked (issue #909). `decline-run` (`job`, `template`, `reason`) declines the job\'s run of the template, waiting or not yet asked (`vault.sandbox_declined`), and the job\'s ask that waits on it is told no; a person\'s deny at gate 2, as `decline`. 404: no such card. Issue #2206: `grant-action` (`job`, `grant`: `role` `<account>/<role>`, `action`, `resource`) grants a job\'s waiting ask for an AWS action (`actionAsks` in the vault\'s view): its need step\'s change on that role is then minted narrowed to the reads and the granted actions, and a later ask of the same scope is covered until the time limit of remembered write approvals (`vault.action_granted`); `decline-action` (`job`, `grant`, `reason`) tells the step no (`vault.action_declined`). A person\'s act: an API token or a delegate approver is refused (403). 404: no such ask waits. An ask on a role the template of the job\'s run card changes is on that card (`runs[].actions`, not in `actionAsks`): the card\'s `approve-run` grants it, and its `decline-run` declines it, so a person decides the card once; an API token or a delegate approver may decide no card with an action (403). A box action. Answers the vault\'s view.', role: 'admin', body: sandboxRequestBody, returns: 'the new view, as GET /api/vault', errors: [400, 403, 404, 409, 503] },
  { method: 'post', path: '/ui/api/sandbox-approvals', tag: 'Vault', summary: 'Skip template approval, skip sandbox approval, or sandbox YOLO', description: 'Issue #991: `skipTemplateApproval`: a template the hopper makes for a job\'s request, and the read policy does not approve, is approved at once, its write, sync and apply profiles with it (`by` `skip template approval`). `skipSandboxApproval`: a box a job asks for starts the moment it asks, a high-blast-radius one too (`by` `skip sandbox approval`). `yolo` sets both; a toggle named with it wins. Issue #1001: `autoApprove` (`low`, `medium`, `high`): the blast radius levels whose templates and runs are approved with no person (`by` `the auto-approve policy`); each level named sets itself; default low on, medium and high off. `rememberWritesHours`: how long a person\'s write, sync or apply approval is remembered for later asks of that asset and access (`by` `a remembered write approval`); 0, until forgotten; default 168. `forgetWrite` (`operation`, `asset`): forget one now (`vault.write_forgotten`). Issue #2206: `revokeAction` (`role`, `action`, `resource`): revoke an action grant now (`vault.action_revoked`); 404 when there is none. Issue #1472: `standingReadGrant`: a job on a box of a template whose needs the read policy holds entirely as reads, with no vault secret, gets the vault grant with no person (`vault.granted`, `by` `standing read grant`); off by default; turned off, it grants no job that has not asked yet. Absent fields keep what was set. Both toggles off by default. Recorded as `vault.sandbox_approvals_set`. A box action: it approves work with no person. Answers the vault\'s view, with `sandboxApprovals`.', role: 'admin', body: sandboxApprovalsBody, returns: 'the new view, as GET /api/vault', errors: [400] },
];

export function registerSandboxRequestRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; grants: Pick<ApiGrants, 'live'>; access: Pick<Access, 'decideVaultGrant'>;
}): void {
  app.post('/ui/api/sandbox-requests', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to decide a sandbox request');
    const b = parseWith(sandboxRequestBody, req.body);
    const parts = o.tenant(req);
    // A delegate approver (issue #1138) decides a request only where its approver policy names nothing of its template.
    const delegate = delegateOf(o.grants, s);
    const by = approverOf(delegate, s);
    if (b.action === 'grant-action' || b.action === 'decline-action') {
      // A person grants an AWS action: an API token or a delegate approver asks one, as it may not decide it.
      if (byApiToken(s) || delegate) throw new HttpError(403, 'a person grants or declines an AWS action, signed in to the UI: an API token may not');
      const scope: ActionScope = b.grant;
      const read = actionsOf([`${scope.action}=${scope.resource}`], scope.role);
      if (typeof read === 'string') throw new HttpError(400, read);
      if (!actionAsks(parts.store, new Date()).some((a) => a.job === b.job && a.role === scope.role && a.action === scope.action && a.resource === scope.resource)) {
        throw new HttpError(404, `no ask of job ${b.job} for ${scope.action} on ${scope.resource} waits`);
      }
      parts.store.tx(() => (b.action === 'grant-action' ? grantAction(parts.store, scope, by, new Date(), b.job) : declineAction(parts.store, scope, b.job, by, b.reason)));
      return await vaultAnswer(parts);
    }
    if (b.action === 'approve-run' || b.action === 'decline-run') {
      const t = parts.vault.view().templates.find((x) => x.name === b.template);
      if (delegate) refuseDenied(delegate, t ? templateNames(t) : [b.template], `deciding the sandbox run of ${b.template} for job ${b.job}`);
      const card = (await vaultAnswer(parts)).runs?.find((c) => c.jobId === b.job && c.template === b.template);
      if (!card || !t) throw new HttpError(404, `no run card of template ${b.template} for job ${b.job}`);
      const actions: ActionScope[] = (card.actions ?? []).map((a) => ({ role: a.role, action: a.action, resource: a.resource }));
      if (actions.length > 0 && (byApiToken(s) || delegate)) throw new HttpError(403, 'this run card asks for an AWS action: a person decides it, signed in to the UI; an API token may not');
      if (b.action === 'decline-run') {
        const r = parts.sandboxRequests.declineRun(b.job, b.template, b.reason, by);
        if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
        parts.store.tx(() => { for (const a of actions) declineAction(parts.store, a, b.job, by, b.reason); });
        parts.engine.denied(b.job, actingOf(s));
        return await vaultAnswer(parts);
      }
      // The card's vault grant (issue #2639 part 3): Access decides first, so a refusal changes nothing.
      if (card.vaultGrant) {
        const job = parts.store.jobs.get(b.job);
        const d = job ? await o.access.decideVaultGrant(s.userId, { ownerId: s.userId, key: grantKeyOf(job) }) : undefined;
        if (d && !d.allowed && d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
        if (d && !d.allowed) throw new HttpError(403, `granting the job the vault is refused: ${d.reason}`);
      }
      // The card's actions are granted first, so the step that wakes on the template's approval finds its grant.
      parts.store.tx(() => { for (const a of actions) grantAction(parts.store, a, by, new Date(), b.job); });
      return await approveRun(parts, b, t, card, { by, ...(byApiToken(s) ? { asker: askerOf(s) } : {}), reply });
    }
    const request = parts.sandboxRequests.list().find((x) => x.id === b.id);
    if (delegate) {
      const template = request?.template;
      const t = parts.vault.view().templates.find((x) => x.name === template);
      refuseDenied(delegate, t ? templateNames(t) : [template], `deciding the sandbox request ${b.id}`);
    }
    const r = b.action === 'approve' ? parts.sandboxRequests.approve(b.id, by) : parts.sandboxRequests.decline(b.id, b.reason, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    if (b.action === 'decline' && request) parts.engine.denied(request.jobId, actingOf(s));
    return await vaultAnswer(parts);
  });

  /**
   * One approval of a run card (issue #2197): the template as it is and each profile it lists, when it waits, then the
   * job's waiting run. An API token's approval of a write, sync or apply profile is asked of a person (issue #909). With
   * no allow again (part 3), the template's approval is for this job's runs only and no write approval is remembered.
   * The card's vault grant (issue #2639 part 3) is given first, so the job's first ask of the vault finds it.
   */
  async function approveRun(parts: TenantParts, b: RunEdit, t: TemplateView, card: RunCardView, who: { by: string; asker?: string; reply: FastifyReply }): Promise<unknown> {
    const allowAgain = b.action === 'approve-run' && b.allowAgain === true;
    const { whole, profiles } = card.waits.template ? approvalsOf(t, b.job) : { whole: false, profiles: [] };
    if (who.asker !== undefined && profiles.some(profileNeedsPerson)) {
      const asked = profiles.filter(profileNeedsPerson).map((p) => askPerson(parts.store, who.reply, profileAsk(t.name, p, who.asker!), b.job).waiting);
      return { waiting: asked.join(' ') };
    }
    if (card.vaultGrant) {
      const r = parts.vault.grant?.(b.job, who.by);
      if (r && !r.ok) throw new HttpError(STATUS[r.code], r.error);
    }
    if (whole) {
      const r = await parts.vault.approveTemplate(t.name, who.by, allowAgain ? undefined : b.job);
      if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    }
    for (const p of profiles) {
      const r = await parts.vault.approveProfile(t.name, { operation: p.operation, asset: p.asset }, who.by);
      if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
      if (allowAgain) rememberApproval(parts.store.settings, { operation: p.operation, asset: p.asset }, who.by, new Date());
    }
    if (card.request) {
      const r = parts.sandboxRequests.approve(card.request, who.by);
      if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    }
    return await vaultAnswer(parts);
  }

  app.post('/ui/api/sandbox-approvals', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the sandbox approvals');
    const { forgetWrite, revokeAction: revoke, ...b } = parseWith(sandboxApprovalsBody, req.body);
    const parts = o.tenant(req);
    const by = personOf(s);
    const { settings, events } = parts.store;
    parts.store.tx(() => {
      if (forgetWrite) {
        settings.setRememberedWrites(forgetting(settings.getRememberedWrites(), forgetWrite));
        events.append({ type: 'vault.write_forgotten', data: { ...forgetWrite, by } });
      }
      if (revoke && !revokeAction(parts.store, revoke, by)) throw new HttpError(404, `no action grant of ${revoke.action} on ${revoke.resource} for aws-role ${revoke.role}`);
      if (Object.keys(b).length === 0 && (forgetWrite || revoke)) return;
      const next = editedApprovals(settings.getSandboxApprovals() ?? NO_SKIPS, b);
      settings.setSandboxApprovals(next);
      events.append({ type: 'vault.sandbox_approvals_set', data: { ...next, autoApprove: autoApproveOf(next), by } });
    });
    return await vaultAnswer(parts);
  });
}
