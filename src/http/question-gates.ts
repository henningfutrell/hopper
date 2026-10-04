// Question gates (issue #18): what the gates that are not plugins hold — the rules and the risk
// rules. The answerer and the assessor are in GET /api/plugins; the rules are edited through
// POST /ui/api/rules (src/http/ui/).
import type { FastifyInstance } from 'fastify';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { QuestionGatesView } from '../domain/types.ts';
import { RISK_RULES, rulesView } from '../questions/index.ts';

export function questionGatesRoutes(app: FastifyInstance, o: { documents: ConfigDocuments }): void {
  app.get('/api/question-gates', async (): Promise<QuestionGatesView> => ({ rules: rulesView(o.documents), riskRules: [...RISK_RULES] }));
}
