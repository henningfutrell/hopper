// Decider calls (issue #550, design.md "Decider calls"): bounded choices with a known option set and a low blast
// radius, which Jev picks first — before an escalation level, a model or a person. Each decision point declares its
// options; Jev picks one with a confidence. In shadow the pick is only recorded, next to what was decided; active, a
// pick at or above the point's threshold is applied, and below it the decision goes on as before.

/** Where the hopper makes a decider call. */
export const DECISION_POINTS = ['question-risk', 'failure-assessment', 'lane-count', 'job-machine', 'intake-order', 'merge-order', 'intake-trust'] as const;
export type DecisionPoint = typeof DECISION_POINTS[number];
/**
 * A point the hopper no longer asks at, which events from before still name: `question-answer`, Jev picking a question's
 * listed option before the levels (issue #550), removed by issue #679 — the Decider is not a question answerer.
 */
export const EVENT_DECISION_POINTS = [...DECISION_POINTS, 'question-answer'] as const;

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
  'question-risk': { mode: 'shadow', threshold: 0.85 },
  'failure-assessment': { mode: 'shadow', threshold: 0.85 },
  'lane-count': { mode: 'shadow', threshold: 0.85 },
  'job-machine': { mode: 'shadow', threshold: 0.85 },
  'intake-order': { mode: 'shadow', threshold: 0.85 },
  'merge-order': { mode: 'shadow', threshold: 0.85 },
  'intake-trust': { mode: 'shadow', threshold: 0.85 },
};

/** What each point is, in plain words (issue #217): the UI's labels. */
export const DECISION_POINT_TEXT: Readonly<Record<DecisionPoint, { label: string; describe: string }>> = {
  'question-risk': {
    label: 'The risk in a question and its answer',
    describe: 'An escalation level answers a question. Jev says how risky the question and the answer are (none, low or real) and of which kinds. Active, its check replaces the keyword risk rules: a real risk, or a check that is not sure enough, sends the question to a person. The guards always hold.',
  },
  'failure-assessment': {
    label: 'A failed job no rule explains',
    describe: 'A job failed with no known cause. Jev picks: run it again, or hand it to a person.',
  },
  'lane-count': {
    label: 'How many lanes a machine runs',
    describe: 'The lane tuning rules recommend new lanes for a machine. Jev picks the lanes from the ones the rules allow. An admin still applies them.',
  },
  'job-machine': {
    label: 'The machine a waiting job goes to',
    describe: 'More than one machine can take a waiting job. Jev picks the machine. Active, a sure pick goes first when that machine has a free lane.',
  },
  'intake-order': {
    label: 'The new item that enters the queue first',
    describe: 'A job source finds more than one new item at once. Jev picks the one that enters the queue first. The rest follow in the source\'s order.',
  },
  'merge-order': {
    label: 'The pull request to rebase and merge next',
    describe: 'More than one waiting pull request of a repository needs tending. The hopper tends one at a time, so that each merge comes before the next rebase. Jev picks the next one.',
  },
  'intake-trust': {
    label: 'The trust of a job before it starts',
    describe: 'A job would start on the trust rules alone. Jev reads its text and where it came from, and keeps its trust level or lowers it, with a reason. Jev can never raise it. Active, the job waits for the check, and a check with no sure answer lowers it: a person then approves its trust on the job.',
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

/** Several choices Jev makes in one call (issue #679), each over its own options, by name; the facts and `instructions` are shared. */
export interface JevChoicesAsk {
  instructions: string;
  state: Record<string, unknown>;
  choices: Readonly<Record<string, { instructions: string; options: readonly MinorDecisionOption[] }>>;
}

/** Jev's pick for each choice, by name; or why it could not answer. */
export type JevChoices = { ok: true; picks: Record<string, { pick: string; confidence: number }> } | { ok: false; why: string };

// ---- The risk call (issue #679) ----------------------------------------------------------------

/** How risky a question and the answer to it are, as the Decider says. */
export const RISK_LEVELS = ['none', 'low', 'real'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];
/** The kinds of risk the Decider names. */
export const RISK_CATEGORIES = ['credentials', 'destructive', 'publish', 'pay', 'permissions', 'ci', 'data', 'other'] as const;
export type RiskCategory = typeof RISK_CATEGORIES[number];

/** The Decider's typed risk decision on a question and a level's answer to it: the risk, its kinds, and how sure (0..1). */
export interface RiskDecision { risk: RiskLevel; categories: RiskCategory[]; confidence: number }

/** What the risk call is asked: the question, the level's answer, the job's goal, and what the keyword risk rules matched. */
export interface QuestionRiskInput {
  jobId: string;
  questionId: string;
  question: string;
  answer: string;
  level: string;
  goal: string;
  /** The keyword risk rules that matched: what the Decider is compared with. */
  rules: readonly string[];
}

/**
 * What the risk call did. Not asked: the point is off, or Jev is off (no TypeSafe API key) — the keyword risk rules
 * decide. Asked: its decision, or why there is none, the point's mode and threshold; only an active point's result is used.
 */
export type QuestionRiskOutcome =
  | { asked: false; why: string }
  | { asked: true; mode: 'shadow' | 'active'; threshold: number; decision?: RiskDecision; error?: string };

/** The Decider's risk call on a question a level answered (issue #679). Never throws. */
export interface QuestionRisk {
  risk(input: QuestionRiskInput): Promise<QuestionRiskOutcome>;
}

/** Why a pick was not applied. `too_late`: the decision was made before Jev answered. */
export const NOT_APPLIED = ['shadow', 'below_threshold', 'consequential', 'no_pick', 'too_late'] as const;
export type NotApplied = typeof NOT_APPLIED[number];

/** A pick and what was decided after it. */
export interface MinorDecisionPickView {
  pickId: string;
  at: string;
  point: DecisionPoint;
  jobId?: string;
  questionId?: string;
  /** The machine the decision is about (`lane-count`). */
  machineId?: string;
  options: MinorDecisionOption[];
  /** Absent: Jev could not answer (`error`). */
  pick?: string;
  /** A risk call's kinds of risk (`question-risk`, issue #679). */
  categories?: RiskCategory[];
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

/**
 * The user's TypeSafe API key (issue #657), as the Jev page shows it: set or not, its last 4 characters, who set it and
 * when. Never the key. `environment`: the runtime variable that still gives one, which the hopper no longer reads (the
 * key was imported from it once). `problem`: why no key can be stored or opened now.
 */
export interface TypesafeKeyView {
  set: boolean;
  last4?: string;
  setAt?: string;
  setBy?: string;
  environment?: { variable: string };
  problem?: string;
}

export interface MinorDecisionsView {
  /** Whether Jev can be asked now; `why` when it cannot (no TypeSafe API key). */
  jev: { available: boolean; why?: string };
  /** The TypeSafe API key Jev asks TypeSafe with (issue #657): set on this page, kept in the vault's system scope. */
  typesafeKey: TypesafeKeyView;
  windowDays: number;
  points: DecisionPointView[];
  /** The newest picks, newest first. */
  recent: MinorDecisionPickView[];
}

/** A setting change for one point: either field; one left out keeps its value. */
export interface DecisionPointPatch { mode?: MinorDecisionMode; threshold?: number }

export const MINOR_DECISION_WINDOW_DAYS = 30;

// ---- Ports ------------------------------------------------------------------------------------

/** Jev, asked to pick one option of a decider call. Never throws: a failure is `{ ok: false }`. */
export interface JevChooser {
  /** Whether Jev can be asked now, and why not: read on every call, so a key set later is used at once. */
  available(): { available: boolean; why?: string };
  pick(ask: MinorDecisionAsk, signal?: AbortSignal): Promise<JevPick>;
  /** Several choices in one call (issue #679: the risk call). */
  choose(ask: JevChoicesAsk, signal?: AbortSignal): Promise<JevChoices>;
  /** One cheap TypeSafe call with `key`, whatever key is stored (issue #657): whether TypeSafe takes it. Never throws; `why` never carries the key. */
  check(key: string): Promise<{ ok: true } | { ok: false; why: string }>;
}

/** A decider call as a decision point hands it to Jev first. */
export interface MinorDecisionInput extends MinorDecisionAsk {
  jobId?: string;
  questionId?: string;
  /** The machine the decision is about (`lane-count`). */
  machineId?: string;
  /** What makes the decision consequential (deletes, sends, publishes, pays, permissions, a gated machine): never applied. */
  consequential: readonly string[];
  /**
   * What was decided while Jev was asked, read when its pick comes: the pick is then not applied (`too_late`) and is
   * compared with it at once. Undefined: still open. Absent: the decision waits for Jev.
   */
  settled?: () => { actual: string; by: string } | undefined;
  /**
   * The option the rules pick without Jev (issue #796): a pick that is not applied is compared with it at once
   * (`decidedBy: rules`). Absent: what is decided is known later.
   */
  rules?: string;
}

/** What Jev first did: not asked (off, or Jev unavailable), or its pick and whether it is applied. */
export type MinorDecisionOutcome =
  | { asked: false }
  | { asked: true; pickId: string; pick?: string; confidence?: number; applied: boolean; notApplied?: NotApplied };

/** Jev first: asked before anything else at every decision point. Never throws. */
export interface JevFirst {
  decide(input: MinorDecisionInput): Promise<MinorDecisionOutcome>;
}
