// Auto-answer (issue #632, design.md "Question pipeline"): an escalation level's answer goes into the job with no person
// when auto-answer is on, the level does not escalate, and its confidence is at or above the threshold. The hard limits
// stay: the risk rules and the consequential guard send the question to a person whatever the level says; a high-priority
// job does only when the user holds those (issue #679). A person may correct an auto-answer later; the corrections against the auto-answers are the agreement stats the
// threshold is tuned on.

/** How sure a level is of its answer, lowest first. */
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface AutoAnswerSettings {
  /** Off: a level's answer is only a recommendation, and every question a level would answer goes to a person. */
  enabled: boolean;
  /** The least confidence a level's answer needs to go into the job. */
  threshold: Confidence;
  /** "Hold high-priority questions for me" (issue #679): a high-priority job's question goes to a person. Absent: off. */
  holdHighPriority?: boolean;
}

export const DEFAULT_AUTO_ANSWER_SETTINGS: Required<AutoAnswerSettings> = { enabled: true, threshold: 'high', holdHighPriority: false };

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

/**
 * The confidence one level gave with the answers it did not escalate, over the window (issue #679): how many at each level
 * of confidence (`none`: it gave none), how many fall below the threshold, and `flagged` when most do — the threshold is
 * then seldom met, and the level's answers seldom go into a job by themselves.
 */
export interface ConfidenceSpread { level: string; high: number; medium: number; low: number; none: number; total: number; below: number; flagged: boolean }

export interface AutoAnswerView extends Required<AutoAnswerSettings> {
  stats: AutoAnswerStats;
  /** Per level, the confidence of its answers that did not escalate (issue #679), in level order of first use. */
  calibration: ConfidenceSpread[];
}

/** What a person's correction of an auto-answer changed: the level's answer it replaced, when, and by whom. */
export interface QuestionCorrection {
  /** The level that gave the auto-answer. */
  level: string;
  /** Its answer, the one corrected. */
  was: string;
  at: string;
  by: string;
}
