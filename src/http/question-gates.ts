// Question gates (issue #18): what the gates that are not plugins hold — the rules file and the
// risk rules. The answerer and the assessor are in GET /api/plugins; the rules file is edited
// through POST /ui/api/rules-file (src/http/ui/).
import type { FastifyInstance } from 'fastify';
import type { QuestionGatesView } from '../domain/types.ts';
import { RISK_RULES, rulesFileView } from '../questions/index.ts';

export function questionGatesRoutes(app: FastifyInstance, o: { rulesFile: string }): void {
  app.get('/api/question-gates', async (): Promise<QuestionGatesView> => ({ rulesFile: rulesFileView(o.rulesFile), riskRules: [...RISK_RULES] }));
}
