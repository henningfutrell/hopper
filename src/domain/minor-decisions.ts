// Minor decisions (issue #550, design.md "Minor decisions"): bounded choices with a known option set and a low blast
// radius, which Jev picks first — before an escalation level, a model or a person. Each decision point declares its
// options; Jev picks one with a confidence. In shadow the pick is only recorded, next to what was decided; active, a
// pick at or above the point's threshold is applied, and below it the decision goes on as before.

/** Where the hopper makes a minor decision. */
export const DECISION_POINTS = ['question-answer', 'failure-assessment'] as const;
export type DecisionPoint = typeof DECISION_POINTS[number];

/** off: Jev is not asked. shadow: Jev's pick is recorded next to what was decided. active: a confident pick is applied. */
export const MINOR_DECISION_MODES = ['off', 'shadow', 'active'] as const;
export type MinorDecisionMode = typeof MINOR_DECISION_MODES[number];

export interface DecisionPointSettings {
  mode: MinorDecisionMode;
  /** The confidence (0..1) a pick needs to be applied, active. */
  threshold: number;
}

export type MinorDecisionSettings = Record<DecisionPoint, DecisionPointSettings>;

/** Every point starts in shadow: Jev decides nothing until a person flips a point that proved reliable. */
export const DEFAULT_MINOR_DECISION_SETTINGS: MinorDecisionSettings = {
  'question-answer': { mode: 'shadow', threshold: 0.85 },
  'failure-assessment': { mode: 'shadow', threshold: 0.85 },
};

/** What each point is, in plain words (issue #217): the UI's labels. */
export const DECISION_POINT_TEXT: Readonly<Record<DecisionPoint, { label: string; describe: string }>> = {
  'question-answer': {
    label: 'Answering a question with listed options',
    describe: 'A job asks a question that lists its options. Jev picks one before any escalation level is asked.',
  },
  'failure-assessment': {
    label: 'A failed job no rule explains',
    describe: 'A job failed with no known cause. Jev picks: run it again, or hand it to a person.',
  },
};

/** One option a decision point offers: its id (what is applied) and what it means. */
export interface MinorDecisionOption { id: string; label: string }

/** The question a decision point asks Jev. */
export interface MinorDecisionAsk {
  point: DecisionPoint;
  /** What to decide, in one line. */
  instructions: string;
  options: readonly MinorDecisionOption[];
  /** What Jev judges from: the facts of the case, never a secret. */
  state: Record<string, unknown>;
}

/** Jev's answer: the option it picks and its confidence; or why it could not answer. */
export type JevPick = { ok: true; pick: string; confidence: number } | { ok: false; why: string };

/** Why a pick was not applied. */
export const NOT_APPLIED = ['shadow', 'below_threshold', 'consequential', 'no_pick'] as const;
export type NotApplied = typeof NOT_APPLIED[number];

/** A pick and what was decided after it. */
export interface MinorDecisionPickView {
  pickId: string;
  at: string;
  point: DecisionPoint;
  jobId?: string;
  questionId?: string;
  options: MinorDecisionOption[];
  /** Absent: Jev could not answer (`error`). */
  pick?: string;
  confidence?: number;
  error?: string;
  mode: MinorDecisionMode;
  threshold: number;
  applied: boolean;
  /** Why it was not applied, and for `consequential` what made it so. */
  notApplied?: NotApplied;
  consequential?: string[];
  /** What was decided in the end, when it is known, and by whom; a person's override replaces it. */
  actual?: string;
  decidedBy?: string;
  agreed?: boolean;
  overridden?: boolean;
}

/** A decision point's settings and its record over the window: the figures a person flips it to active on. */
export interface DecisionPointView extends DecisionPointSettings {
  point: DecisionPoint;
  label: string;
  describe: string;
  /** Jev was asked. */
  asked: number;
  /** Jev answered with a pick. */
  picked: number;
  /** Its pick was applied. */
  applied: number;
  /** Picks with what was decided known: a later tier's decision, or a person's override. */
  compared: number;
  agreed: number;
  /** agreed / compared; null with nothing compared. */
  agreement: number | null;
  overridden: number;
}

export interface MinorDecisionsView {
  /** Whether Jev can be asked now; `why` when it cannot (no TypeSafe key, no typesafe_sdk). */
  jev: { available: boolean; why?: string };
  windowDays: number;
  points: DecisionPointView[];
  /** The newest picks, newest first. */
  recent: MinorDecisionPickView[];
}

/** A setting change for one point: either field; one left out keeps its value. */
export interface DecisionPointPatch { mode?: MinorDecisionMode; threshold?: number }

export const MINOR_DECISION_WINDOW_DAYS = 30;

// ---- Ports ------------------------------------------------------------------------------------

/** Jev, asked to pick one option of a minor decision. Never throws: a failure is `{ ok: false }`. */
export interface JevChooser {
  /** Whether Jev can be asked now, and why not: read on every call, so a key set later is used at once. */
  available(): { available: boolean; why?: string };
  pick(ask: MinorDecisionAsk, signal?: AbortSignal): Promise<JevPick>;
}

/** A minor decision as a decision point hands it to Jev first. */
export interface MinorDecisionInput extends MinorDecisionAsk {
  jobId?: string;
  questionId?: string;
  /** What makes the decision consequential (deletes, sends, publishes, pays, permissions, a gated machine): never applied. */
  consequential: readonly string[];
}

/** What Jev first did: not asked (off, or Jev unavailable), or its pick and whether it is applied. */
export type MinorDecisionOutcome =
  | { asked: false }
  | { asked: true; pickId: string; pick?: string; confidence?: number; applied: boolean; notApplied?: NotApplied };

/** Jev first: asked before anything else at every decision point. Never throws. */
export interface JevFirst {
  decide(input: MinorDecisionInput): Promise<MinorDecisionOutcome>;
}
