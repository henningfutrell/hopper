// Question gates (issue #18): what the gates that are not plugins hold — the rules, the risk
// rules and auto-answer with its agreement stats (issue #632). The escalation levels are in GET /api/plugins; the rules are edited through
// POST /ui/api/rules (src/http/ui/).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Clock } from '../domain/ports.ts';
import type { QuestionGatesView } from '../domain/types.ts';
import { autoAnswerView } from '../questions/auto-answer.ts';
import { RISK_RULES, rulesView } from '../questions/index.ts';
import type { TenantParts } from './tenants.ts';

export function questionGatesRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/question-gates', async (req): Promise<QuestionGatesView> => {
    const { store } = o.tenant(req);
    return { rules: rulesView(store.config), riskRules: [...RISK_RULES], autoAnswer: autoAnswerView(store, o.clock) };
  });
}
