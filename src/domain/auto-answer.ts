// Auto-answer (issue #632, design.md "Question pipeline"): an escalation level's answer goes into the job with no person
// when auto-answer is on, the level does not escalate, and its confidence is at or above the threshold. The hard limits
// stay: the risk rules, the consequential guard and a high-priority job send the question to a person whatever the level
// says. A person may correct an auto-answer later; the corrections against the auto-answers are the agreement stats the
// threshold is tuned on.

/** How sure a level is of its answer, lowest first. */
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface AutoAnswerSettings {
  /** Off: a level's answer is only a recommendation, and every question a level would answer goes to a person. */
  enabled: boolean;
  /** The least confidence a level's answer needs to go into the job. */
  threshold: Confidence;
}

export const DEFAULT_AUTO_ANSWER_SETTINGS: AutoAnswerSettings = { enabled: true, threshold: 'high' };

/** The agreement stats are counted over this many days. */
export const AUTO_ANSWER_WINDOW_DAYS = 30;

/** `confidence` meets `threshold`; no confidence meets none. */
export const meetsThreshold = (confidence: Confidence | undefined, threshold: Confidence): boolean =>
  confidence !== undefined && CONFIDENCES.indexOf(confidence) >= CONFIDENCES.indexOf(threshold);

/** The answers levels typed into jobs over the window, and how many of them a person corrected. */
export interface AutoAnswerStats {
  windowDays: number;
  answered: number;
  corrected: number;
  /** The share not corrected, 0–1; absent with no auto-answers. */
  agreement?: number;
}

export interface AutoAnswerView extends AutoAnswerSettings { stats: AutoAnswerStats }

/** What a person's correction of an auto-answer changed: the level's answer it replaced, when, and by whom. */
export interface QuestionCorrection {
  /** The level that gave the auto-answer. */
  level: string;
  /** Its answer, the one corrected. */
  was: string;
  at: string;
  by: string;
}
