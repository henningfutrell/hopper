// The token budget (issue #2302, part 3, design.md "The token ledger"): the most one job may spend, in tokens or in
// estimated cost, before it is paused; 0: no cap. Part 5: the most the jobs may spend in one UTC day, in all or per
// repository, before a waiting job is held. An admin's; read at each checkpoint and each Decision, so a change applies
// without a restart. Read at GET /api/token-budget.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_BUDGET_COST_USD, MAX_BUDGET_TOKENS, tokenBudgetOf, type TokenBudgetSettings } from '../../domain/token-budget.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const tokens = z.number().int().min(0).max(MAX_BUDGET_TOKENS).optional();
const cost = z.number().min(0).max(MAX_BUDGET_COST_USD).optional();
const CAPS = ['jobTokens', 'jobCostUsd', 'dayTokens', 'dayCostUsd', 'repoDayTokens', 'repoDayCostUsd'] as const;

/** Any of the caps; one left out keeps its value. */
export const tokenBudgetBody = z.strictObject({ jobTokens: tokens, jobCostUsd: cost, dayTokens: tokens, dayCostUsd: cost, repoDayTokens: tokens, repoDayCostUsd: cost })
  .refine((b) => CAPS.some((k) => b[k] !== undefined), { message: `name one of ${CAPS.join(', ')}` });

export const TOKEN_BUDGET_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/token-budget', tag: 'Machines and usage', summary: 'The token budget', description: 'Issue #2302: the most one job may spend before it is paused — `jobTokens` (every token: input, output, cache read and cache write) and `jobCostUsd` (the estimated cost); 0: no cap. Default: no cap. A running job whose token ledger reaches either cap at a checkpoint is parked, its work tree and agent session kept, and Needs you lists it (`budgetPaused` on the job). A person\'s pick up lets it go on: the cap then counts from what it had spent then (`budgetFrom`). Part 5, the day budgets: `dayTokens` and `dayCostUsd`, the most all the jobs may spend in one UTC day; `repoDayTokens` and `repoDayCostUsd`, the most the jobs of each repository may. A day is counted as the ledger\'s `day` group counts it (the UTC day of a session\'s last counted message). While one is reached, each waiting job it covers — new, or going on after a question or a pick up — is held with why (`holdReason`), until the next UTC day or a raise; a running job runs on.', returns: '`TokenBudgetSettings`' },
  { method: 'post', path: '/ui/api/token-budget', tag: 'Machines and usage', summary: 'Change the token budget', description: 'Any of the caps; one left out keeps its value (`token_budget.settings_changed`). 0 turns that cap off. Applies from the next checkpoint and the next Decision, without a restart.', role: 'admin', body: tokenBudgetBody, returns: '`TokenBudgetSettings`', errors: [400] },
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
      const to: TokenBudgetSettings = { ...from };
      for (const k of CAPS) to[k] = patch[k] ?? from[k];
      if (CAPS.every((k) => from[k] === to[k])) return;
      t.store.settings.setTokenBudget(to);
      t.store.events.append({ type: 'token_budget.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return tokenBudgetView(t);
  });
}
