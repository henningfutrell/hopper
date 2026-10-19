// Pending approvals (issue #2088, design.md "Pending approvals"): every GitHub Actions run that waits for a deployment
// approval the user can give, across the intake orgs, as the last background read found it. A read only: the hopper never
// approves or rejects a deployment, so there is no route that acts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Operation } from '../openapi-operation.ts';
import type { TenantParts } from '../tenants.ts';

export const PENDING_APPROVAL_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/pending-approvals', tag: 'Jobs', summary: 'Pending approvals: deployment approvals that wait on you', description: 'Issue #2088: each GitHub Actions run with `status=waiting` whose pending deployments hold an environment the user\'s connection can approve (`current_user_can_approve`), in the repositories that are not archived of the **intake orgs** — the owners of each connected account\'s job repositories — which that account reaches. One row per run: `repo`, `runId`, `workflow`, `title`, `environments`, `waitingSince`, `url` (the run\'s page), and `stale` when a newer waiting run of the same repository waits on each of its environments; fresh rows first, the longest waiting first. `orgs` the intake orgs, `problems` what GitHub refused (a repository, or an account as a whole), `checkedAt` when the last read ended, `reading` while one runs. Never read from GitHub at request time: the user\'s schedule reads every 5 minutes, each GET conditional, so an unchanged answer (304) costs no call. Kept in memory only. Read-only: no route approves or rejects a deployment.', returns: '`PendingApprovalsView`' },
];

export function pendingApprovalReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/pending-approvals', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).githubProxy.pendingApprovals.view();
  });
}
