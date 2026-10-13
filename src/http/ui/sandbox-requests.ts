// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): a person approves or declines a job's sandbox
// request on Access requests, and an admin sets the two toggles that skip a person — skip template approval, skip
// sandbox approval — or sandbox YOLO, both. Both are box actions: approving a request starts a box, and the toggles
// approve work with no person. Each answers the vault's view, which carries the requests and the toggles.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { editedApprovals, NO_SKIPS } from '../../domain/sandbox-approvals.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { vaultAnswer } from '../vault.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const sandboxRequestBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), id: z.string().max(64) }),
  z.strictObject({ action: z.literal('decline'), id: z.string().max(64), reason: z.string().trim().min(1).max(500) }),
]);
export const sandboxApprovalsBody = z.strictObject({ yolo: z.boolean().optional(), skipTemplateApproval: z.boolean().optional(), skipSandboxApproval: z.boolean().optional() });

const STATUS = { not_found: 404, conflict: 409 } as const;

export const SANDBOX_REQUEST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/sandbox-requests', tag: 'Vault', summary: 'Approve or decline a job\'s sandbox request', description: 'Issue #991: a running job asks for a box of the template its needs make (`sh "$HOPPER_SKILL" sandbox --needs …`); unless skip sandbox approval is on, the request waits here (the vault\'s view lists it in `sandboxRequests`). `approve` (`id`) starts the box through the sandbox module, with the template\'s defaults (`vault.sandbox_approved`, then `vault.sandbox_started` or `vault.sandbox_failed`); `decline` (`id`, `reason`) tells the job no (`vault.sandbox_declined`). Each on the job\'s timeline. 404: no such request; 409: it does not wait. A box action. Answers the vault\'s view.', role: 'admin', body: sandboxRequestBody, returns: 'the new view, as GET /api/vault', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/sandbox-approvals', tag: 'Vault', summary: 'Skip template approval, skip sandbox approval, or sandbox YOLO', description: 'Issue #991: `skipTemplateApproval`: a template the hopper makes for a job\'s request, and the read policy does not approve, is approved at once, its write, sync and apply profiles with it (`by` `skip template approval`). `skipSandboxApproval`: a box a job asks for starts the moment it asks, a high-blast-radius one too (`by` `skip sandbox approval`). `yolo` sets both; a toggle named with it wins. Absent fields keep what was set. Both off by default. Recorded as `vault.sandbox_approvals_set`. A box action: it approves work with no person. Answers the vault\'s view, with `sandboxApprovals`.', role: 'admin', body: sandboxApprovalsBody, returns: 'the new view, as GET /api/vault', errors: [400] },
];

export function registerSandboxRequestRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/sandbox-requests', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to decide a sandbox request');
    const b = parseWith(sandboxRequestBody, req.body);
    const parts = o.tenant(req);
    const by = identityName(s.identity);
    const r = b.action === 'approve' ? parts.sandboxRequests.approve(b.id, by) : parts.sandboxRequests.decline(b.id, b.reason, by);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return await vaultAnswer(parts);
  });

  app.post('/ui/api/sandbox-approvals', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the sandbox approvals');
    const b = parseWith(sandboxApprovalsBody, req.body);
    const parts = o.tenant(req);
    const next = editedApprovals(parts.store.settings.getSandboxApprovals() ?? NO_SKIPS, b);
    parts.store.tx(() => {
      parts.store.settings.setSandboxApprovals(next);
      parts.store.events.append({ type: 'vault.sandbox_approvals_set', data: { ...next, by: identityName(s.identity) } });
    });
    return await vaultAnswer(parts);
  });
}
