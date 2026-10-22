// The work-item ledger's read (issue #1067, design.md "The work-item ledger"): where each work item stands, and how many
// are in each state — the one count every view reads. Read-only: only the ledger's reducer writes it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WORK_ITEM_STATES, type WorkItemState } from '../domain/work-items.ts';
import { parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

export const workItemsQuery = z.object({
  state: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (!(WORK_ITEM_STATES as readonly string[]).includes(p)) ctx.addIssue({ code: 'custom', message: `unknown state ${p}` });
    }
    return parts as WorkItemState[];
  }),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const WORK_ITEM_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/work-items', tag: 'Jobs', summary: 'The work-item ledger', description: 'Where each work item stands (issue #1067): one item per source key, whichever of its jobs works it, written only by the ledger\'s reducer in the transaction of the event that moves it. `counts`: how many items are in each state — `waiting_for_approval`, `queued`, `working`, `needs_you`, `waiting_outside`, `pr_open`, `partly_done`, `done`, `failed` (the last attempt failed, nothing took its place and nobody dismissed it: the only failure counted) and `dropped` —, every state named, zero included. `items`: the items, the newest state change first, each with its `state`, `stateSince`, its last move (`eventAt`) and who made it (`movedBy`: `scheduler`, `lane_worker`, `github_observer`, `assessor`, `reconciler` or `person`; issue #1892), its job (`jobId`), its pull request, its state and what it waits on (`pullRequestWait`: `draft`, `conflicts`, `fixing_checks`, `checks_running`, `merge`), its issue\'s state and why it closed, what it waits on (`waitingOn`, in plain words), the job whose failure it is (`failedJobId`) the jobs whose work was kept, not pushed (`keptWork`), and, for a pull request merged into a landing branch (issue #1073), its `landing` stage: `stage` (`waiting`, `batch_run`, `bisecting`, `culprit`, `reverted`, `promoted`), `since`, the batch run\'s `tip` and pull request (`batch`), a culprit\'s `revert` and `fixIssue`. `state` (comma-separated) filters the items, never the counts; `limit` (1 to 1000, default 200). 400: an unknown state.', query: workItemsQuery, returns: '`{ counts: Record<WorkItemState, number>, items: WorkItem[] }`', errors: [400] },
];

export function workItemRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/work-items', async (req) => {
    const q = parseWith(workItemsQuery, req.query);
    const { workItems } = o.tenant(req).store;
    return { counts: workItems.counts(), items: workItems.list({ ...(q.state ? { state: q.state } : {}), limit: q.limit }) };
  });
}
