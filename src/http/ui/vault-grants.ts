// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a person grants a job's item the vault, or takes the
// grant back. A person's act through the UI session — a job's routes reach no `/ui/api/` —, the owner only, as Access
// decides (OpenFGA `vault_grant#can_grant`); 503 when it cannot be asked. Each answers the vault's view. Least role: operator.
// A person, or a delegate approver (issue #1138), may deny an ask instead. A delegate grants or denies only an ask that
// waits, within its approver policy, and the grant records it with the person it acts for.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { ACCESS_UNAVAILABLE } from '../../domain/access.ts';
import { grantKeyOf } from '../../domain/vault-grants.ts';
import type { VaultResult } from '../../vault/service.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { templateNames } from '../../domain/delegates.ts';
import { vaultAnswer } from '../vault.ts';
import type { ApiGrants } from './api-grants.ts';
import { approverOf, delegateOf, refuseDenied } from './delegates.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const idParams = z.object({ id: z.string() });
const STATUS = { invalid: 400, not_found: 404, conflict: 409, unavailable: 503 } as const;

export const VAULT_GRANT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/jobs/:id/grant-vault', tag: 'Vault', summary: 'Grant a job the vault', description: 'Issue #652: the job\'s item — and so this job, and the jobs Run again or Rework make of it — may use the vault\'s helper: the vault secrets and minted credentials its box\'s template gives, never more. Until then a job on a box that asks is refused, and shows on Access requests as a grant ask (`grantAsks`). `vault.granted`. The owner only: Access (OpenFGA, `vault_grant#can_grant`) decides first (403), 503 when it cannot be asked. A job asks, never grants.', role: 'operator', returns: 'the vault\'s view', errors: [403, 404, 503] },
  { method: 'post', path: '/ui/api/jobs/:id/deny-vault', tag: 'Vault', summary: 'Deny a job\'s vault grant ask', description: 'Issue #1138: the job\'s grant ask goes, and the job, which still has no vault grant, asks no more; Run again makes a new job, which may ask again. `vault.grant_denied`. Access decides as for a grant. A delegate approver\'s token (the preset `delegate-approver`) grants and denies only an ask that waits (409 else), and is refused (403) an ask its approver policy names: the template, the machine or Windows host, a name the job asked for, or the template\'s secrets and assets. 409: no ask waits for the job.', role: 'operator', returns: 'the vault\'s view', errors: [403, 404, 409, 503] },
  { method: 'post', path: '/ui/api/jobs/:id/revoke-vault', tag: 'Vault', summary: 'Take a job\'s vault grant back', description: 'Issue #652: the job\'s item\'s jobs get nothing from the vault again. `vault.grant_revoked`. Access decides as for a grant. 409: the item has no vault grant.', role: 'operator', returns: 'the vault\'s view', errors: [403, 404, 409, 503] },
];

export function registerVaultGrantRoutes(app: FastifyInstance, o: {
  operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideVaultGrant'>; grants: Pick<ApiGrants, 'live'>;
}): void {
  const act = (path: string, doing: string, change: (t: TenantParts, jobId: string, by: string) => VaultResult | undefined, delegated = false) =>
    app.post(path, o.operator, async (req) => {
      const s = signedInOf(req);
      if (!s) throw new HttpError(401, `sign in to ${doing}`);
      const t = o.tenant(req);
      const job = t.store.jobs.get(parseWith(idParams, req.params).id);
      if (!job) throw new HttpError(404, `job ${parseWith(idParams, req.params).id} not found`);
      // The job is the hopper's user's whose jobs these are: Access decides whether the person signed in may grant for them.
      const d = await o.access.decideVaultGrant(s.userId, { ownerId: s.userId, key: grantKeyOf(job) });
      if (!d.allowed && d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      if (!d.allowed) throw new HttpError(403, `${doing} is refused: ${d.reason}`);
      const delegate = delegateOf(o.grants, s);
      if (delegate && delegated) {
        // A delegate approver decides only what waits for a person, within its approver policy.
        const view = t.vault.view();
        const ask = view.grantAsks?.find((a) => a.job === job.id);
        if (!ask) throw new HttpError(409, `${doing} is refused: no grant ask waits for job ${job.id}, and a delegate approver decides only what waits`);
        const template = view.templates.find((x) => x.name === ask.template);
        refuseDenied(delegate, [ask.template, ask.machine, ask.windowsHost, ...ask.names, ...(template ? templateNames(template) : [])], doing);
      }
      const r = change(t, job.id, approverOf(delegate, s));
      if (!r) throw new HttpError(503, 'this hopper\'s vault keeps no vault grants');
      if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
      return vaultAnswer(t);
    });
  act('/ui/api/jobs/:id/grant-vault', 'granting the job the vault', (t, id, by) => t.vault.grant?.(id, by), true);
  act('/ui/api/jobs/:id/deny-vault', 'denying the job\'s grant ask', (t, id, by) => t.vault.denyGrant?.(id, by), true);
  act('/ui/api/jobs/:id/revoke-vault', 'taking the job\'s vault grant back', (t, id, by) => t.vault.revokeGrant?.(id, by));
}
