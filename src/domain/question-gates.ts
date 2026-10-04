// Question gates (issue #18): the gates a question passes that are not plugins — the rules file
// and the risk rules — as GET /api/question-gates reports them. docs/glossary.md "Question gates".

/** The rules file as read now. `version`: sha-256 of its bytes, or `missing`; an edit carries it back. */
export interface RulesFileView {
  path: string;
  text: string;
  version: string;
  missing: boolean;
}

/** One risk rule: code, not configuration — listed, never edited. */
export interface RiskRuleView {
  name: string;
  /** One line: what it catches. */
  describe: string;
}

/** GET /api/question-gates: what the gates that are not plugins hold. The answerer and assessor are in GET /api/plugins. */
export interface QuestionGatesView {
  rulesFile: RulesFileView;
  riskRules: RiskRuleView[];
}
