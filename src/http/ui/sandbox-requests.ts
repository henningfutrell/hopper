// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): a person approves or declines a job's sandbox
// request on Access requests, and an admin sets the two toggles that skip a person — skip template approval, skip
// sandbox approval — or sandbox YOLO, both. Both are box actions: approving a request starts a box, and the toggles
// approve work with no person. Each answers the vault's view, which carries the requests and the toggles. A decline is a
// person's deny at gate 2 (issue #655, part 5): the job's trust one level lower, the second quarantines it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS } from '../../domain/access.ts';
import { forgetting, REMEMBER_HOURS_MAX } from '../../domain/remembered-writes.ts';
import { autoApproveOf, editedApprovals, NO_SKIPS } from '../../domain/sandbox-approvals.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { vaultAnswer } from '../vault.ts';
import { templateNames } from '../../domain/delegates.ts';
import type { ApiGrants } from './api-grants.ts';
import { approverOf, delegateOf, refuseDenied } from './delegates.ts';
import { actingOf, personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const sandboxRequestBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), id: z.string().max(64) }),
  z.strictObject({ action: z.literal('decline'), id: z.string().max(64), reason: z.string().trim().min(1).max(500) }),
]);
export const sandboxApprovalsBody = z.strictObject({
  yolo: z.boolean().optional(), skipTemplateApproval: z.boolean().optional(), skipSandboxApproval: z.boolean().optional(),
  // Issue #1001: the auto-approve policy; each level named sets itself.
  autoApprove: z.strictObject({ low: z.boolean().optional(), medium: z.boolean().optional(), high: z.boolean().optional() }).optional(),
  // Issue #1001: how long a person's write approval is remembered (0: until forgotten), and one to forget now.
  rememberWritesHours: z.number().int().min(0).max(REMEMBER_HOURS_MAX).optional(),
  // Issue #1472: the standing read grant.
  standingReadGrant: z.boolean().optional(),
  forgetWrite: z.strictObject({ operation: z.enum(['write', 'sync', 'apply']), asset: z.strictObject({ kind: z.enum(ASSET_KINDS), name: z.string().max(200) }) }).optional(),
});

const STATUS = { not_found: 404, conflict: 409 } as const;

export const SANDBOX_REQUEST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/sandbox-requests', tag: 'Vault', summary: 'Approve or decline a job\'s sandbox request', description: 'Issue #991: a running job asks for sandbox runs of the template its needs make (`sh "$HOPPER_SKILL" sandbox --needs …`); unless skip sandbox approval is on, the auto-approve policy holds the template\'s blast radius, or a person approved the template this job asked for (issue #1001), the request waits here (the vault\'s view lists it in `sandboxRequests`). `approve` (`id`) approves the job\'s sandbox runs (`vault.sandbox_approved`): it starts no box, and each of the job\'s box steps then runs in a sandbox of its own, burned after it (issue #1349); `decline` (`id`, `reason`) tells the job no (`vault.sandbox_declined`), and is a person\'s deny at gate 2 (issue #655 part 5): the job\'s trust stamp one level lower (`job.trust_lowered`), and the second decline in the job quarantines it (`job.quarantined`, its proxy token then opens no door of the hopper). Each on the job\'s timeline. 404: no such request; 409: it does not wait. A box action. Answers the vault\'s view.', role: 'admin', body: sandboxRequestBody, returns: 'the new view, as GET /api/vault', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/sandbox-approvals', tag: 'Vault', summary: 'Skip template approval, skip sandbox approval, or sandbox YOLO', description: 'Issue #991: `skipTemplateApproval`: a template the hopper makes for a job\'s request, and the read policy does not approve, is approved at once, its write, sync and apply profiles with it (`by` `skip template approval`). `skipSandboxApproval`: a box a job asks for starts the moment it asks, a high-blast-radius one too (`by` `skip sandbox approval`). `yolo` sets both; a toggle named with it wins. Issue #1001: `autoApprove` (`low`, `medium`, `high`): the blast radius levels whose templates and runs are approved with no person (`by` `the auto-approve policy`); each level named sets itself; default low on, medium and high off. `rememberWritesHours`: how long a person\'s write, sync or apply approval is remembered for later asks of that asset and access (`by` `a remembered write approval`); 0, until forgotten; default 168. `forgetWrite` (`operation`, `asset`): forget one now (`vault.write_forgotten`). Issue #1472: `standingReadGrant`: a job on a box of a template whose needs the read policy holds entirely as reads, with no vault secret, gets the vault grant with no person (`vault.granted`, `by` `standing read grant`); off by default; turned off, it grants no job that has not asked yet. Absent fields keep what was set. Both toggles off by default. Recorded as `vault.sandbox_approvals_set`. A box action: it approves work with no person. Answers the vault\'s view, with `sandboxApprovals`.', role: 'admin', body: sandboxApprovalsBody, returns: 'the new view, as GET /api/vault', errors: [400] },
];

export function registerSandboxRequestRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; grants: Pick<ApiGrants, 'live'> }): void {
  app.post('/ui/api/sandbox-requests', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to decide a sandbox request');
    const b = parseWith(sandboxRequestBody, req.body);
    const parts = o.tenant(req);
    // A delegate approver (issue #1138) decides a request only where its approver policy names nothing of its template.
    const delegate = delegateOf(o.grants, s);
    const by = approverOf(delegate, s);
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

  app.post('/ui/api/sandbox-approvals', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the sandbox approvals');
    const { forgetWrite, ...b } = parseWith(sandboxApprovalsBody, req.body);
    const parts = o.tenant(req);
    const by = personOf(s);
    const { settings, events } = parts.store;
    parts.store.tx(() => {
      if (forgetWrite) {
        settings.setRememberedWrites(forgetting(settings.getRememberedWrites(), forgetWrite));
        events.append({ type: 'vault.write_forgotten', data: { ...forgetWrite, by } });
      }
      if (Object.keys(b).length === 0 && forgetWrite) return;
      const next = editedApprovals(settings.getSandboxApprovals() ?? NO_SKIPS, b);
      settings.setSandboxApprovals(next);
      events.append({ type: 'vault.sandbox_approvals_set', data: { ...next, autoApprove: autoApproveOf(next), by } });
    });
    return await vaultAnswer(parts);
  });
}
