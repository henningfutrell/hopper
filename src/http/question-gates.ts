// Question gates (issue #18): what the gates that are not plugins hold — the rules and the risk
// rules. The escalation levels are in GET /api/plugins; the rules are edited through
// POST /ui/api/rules (src/http/ui/).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { QuestionGatesView } from '../domain/types.ts';
import { RISK_RULES, rulesView } from '../questions/index.ts';
import type { TenantParts } from './tenants.ts';

export function questionGatesRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/question-gates', async (req): Promise<QuestionGatesView> => ({ rules: rulesView(o.tenant(req).store.documents), riskRules: [...RISK_RULES] }));
}
