// The token budget (issue #2302, part 3, design.md "The token ledger"): the most one job may spend, in tokens or in
// estimated cost, before it is paused; 0: no cap. An admin's; read at each checkpoint, so a change applies without a
// restart. Read at GET /api/token-budget.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_BUDGET_COST_USD, MAX_BUDGET_TOKENS, tokenBudgetOf, type TokenBudgetSettings } from '../../domain/token-budget.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Either cap; one left out keeps its value. */
export const tokenBudgetBody = z.strictObject({
  jobTokens: z.number().int().min(0).max(MAX_BUDGET_TOKENS).optional(),
  jobCostUsd: z.number().min(0).max(MAX_BUDGET_COST_USD).optional(),
}).refine((b) => b.jobTokens !== undefined || b.jobCostUsd !== undefined, { message: 'name jobTokens or jobCostUsd' });

export const TOKEN_BUDGET_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/token-budget', tag: 'Machines and usage', summary: 'The token budget', description: 'Issue #2302: the most one job may spend before it is paused — `jobTokens` (every token: input, output, cache read and cache write) and `jobCostUsd` (the estimated cost); 0: no cap. Default: no cap. A running job whose token ledger reaches either cap at a checkpoint is parked, its work tree and agent session kept, and Needs you lists it (`budgetPaused` on the job). A person\'s pick up lets it go on: the cap then counts from what it had spent then (`budgetFrom`).', returns: '`TokenBudgetSettings`' },
  { method: 'post', path: '/ui/api/token-budget', tag: 'Machines and usage', summary: 'Change the token budget', description: 'Either cap; one left out keeps its value (`token_budget.settings_changed`). 0 turns that cap off. Applies from the next checkpoint, without a restart.', role: 'admin', body: tokenBudgetBody, returns: '`TokenBudgetSettings`', errors: [400] },
];

export const tokenBudgetView = (t: Pick<TenantParts, 'store'>): TokenBudgetSettings => tokenBudgetOf(t.store.settings.getTokenBudget());

export function registerTokenBudgetRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/token-budget', async (req) => tokenBudgetView(o.tenant(req)));
  app.post('/ui/api/token-budget', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the token budget');
    const t = o.tenant(req);
    const patch = parseWith(tokenBudgetBody, req.body);
    t.store.tx(() => {
      const from = tokenBudgetView(t);
      const to: TokenBudgetSettings = { jobTokens: patch.jobTokens ?? from.jobTokens, jobCostUsd: patch.jobCostUsd ?? from.jobCostUsd };
      if (from.jobTokens === to.jobTokens && from.jobCostUsd === to.jobCostUsd) return;
      t.store.settings.setTokenBudget(to);
      t.store.events.append({ type: 'token_budget.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return tokenBudgetView(t);
  });
}
