// The disk budget (issue #1120, design.md "Hopper's own disk use" → "Part 2"): an admin sets the most the hopper's own disk
// use may be on each machine, or turns it off. Read at each sweep, so it applies without a restart; GET
// /api/machines/disk-budget reads it, and each machine of GET /api/machines carries it with its measure (`hopperDisk`).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The disk budget: the most the hopper's own disk use may be on each machine, in bytes; null: none. */
export const diskBudgetBody = z.strictObject({
  budget: z.strictObject({ bytes: z.number().int().positive('a budget above 0') }).nullable(),
});

/** The disk budget's part of the API reference (src/http/openapi.ts). */
export const DISK_BUDGET_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/machines/disk-budget', tag: 'Machines and usage', summary: 'The disk budget', description: 'Issue #1120. The most the hopper\'s own disk use (its scratch areas and job worktrees) may be on each machine; null: none.', returns: '`{ diskBudget: DiskBudget | null }`' },
  { method: 'post', path: '/ui/api/machines/disk-budget', tag: 'Machines and usage', summary: 'Set the disk budget', description: 'Issue #1120. The sweep measures the hopper\'s own disk use on each machine (`hopperDisk` on GET /api/machines). Over `budget.bytes`, it reaps every ended job\'s scratch dir at once, whatever its age (work not pushed is still kept); still over, a person is told as `machine.disk_over_budget`, and as `machine.disk_within_budget` once it is back within it; webhooks take them. `budget: null` turns it off.', role: 'admin', body: diskBudgetBody, returns: '`{ diskBudget: DiskBudget | null }`' },
];

export function registerDiskBudgetRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/machines/disk-budget', async (req) => ({ diskBudget: o.tenant(req).store.settings.getDiskBudget() ?? null }));
  app.post('/ui/api/machines/disk-budget', o.admin, async (req) => {
    const { budget } = parseWith(diskBudgetBody, req.body);
    o.tenant(req).store.settings.setDiskBudget(budget);
    return { diskBudget: budget };
  });
}
