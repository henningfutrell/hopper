// The escalation levels' seams, apart from ports.ts for its size and re-exported there: what a level is given to
// answer a question, and to review a review item — a proposal or a research report (issues #537, #543, design.md
// "Sections"); the document an executor reports; the review.
import type { RunLogins } from './logins.ts';
import type { Confidence, Question, QuestionAttempt, ReviewDecisionId, ReviewEntry, ReviewItem, ReviewKind, ReviewVerdict, ReviewVersion, ShiftThen } from './types.ts';

/** Everything an escalation level is given. */
export interface AnswerRequest {
  question: Question;
  /** The job's full prompt. */
  jobPrompt: string;
  jobGoal?: string;
  /** The owner's standing rules, read from the rules file at ask time. */
  rules: string;
  /** The question's trail so far — earlier runs, and the levels below this one with their recommendations. */
  previous: QuestionAttempt[];
  /** Where this level stands: `number` of `of` (1 is the lowest). Above level `of` is the owner. */
  level: { number: number; of: number };
  /** The machine the job runs on, or waits on for the answer (issue #442): a level that names no machine runs there when it can. */
  jobMachine?: string;
  /** Where the level's run reports a login it waits on (issue #476): never an answer, never a climb of its own. */
  logins?: RunLogins;
}

/**
 * An escalation level's reply: answer the question (`escalate: false`, with the `answer` to type
 * into the job), or send it to the next level up (`escalate: true`; `answer`, when given, is this
 * level's recommendation, on the trail).
 */
export interface LevelReply {
  answer?: string;
  escalate: boolean;
  reason: string;
  /** How sure it is of `answer` (issue #632): an answer goes into the job only at or above the auto-answer threshold. Absent: below every threshold. */
  confidence?: Confidence;
  /** The model that ran, as its provider reports it (the trail shows it in place of the configured alias). */
  model?: string;
  /** The machine it ran on and why, when the level named none and picked it (issue #442): on the trail. */
  machine?: { id: string; why: string };
  /**
   * A phase shift it suggests (issue #548): research or a proposal first, about `note`. A level the phase-shift settings
   * allow shifts the job itself, in the default mode; any other's suggestion is shown to the person.
   */
  suggest?: { to: ReviewKind; note?: string };
}

/**
 * The escalation-level role: one rung a question climbs. Never throws by contract; the question
 * service fails closed on its reply all the same: only a schema-valid `escalate: false` with an
 * answer answers; an error, a throw, a timeout or anything malformed escalates to the next level up.
 */
export interface EscalationLevel {
  /** The instance name (the plugins config), which is also the question's stage while this level holds it. */
  readonly name: string;
  /** The model it runs, for the trail. */
  readonly model?: string;
  answer(req: AnswerRequest, signal: AbortSignal): Promise<LevelReply | { error: string }>;
  /**
   * Review a review item — a proposal or a research report — as a reviewer level (issues #537, #543). Never throws by
   * contract; the review service fails closed all the same: an error or anything malformed escalates. Absent: the level
   * cannot review, and every item it gets escalates.
   */
  review?(req: ReviewRequest, signal: AbortSignal): Promise<ReviewReply | { error: string }>;
}

/** A document the agent wrote instead of doing the work — a proposal, a research report — ended with its section's marker. */
export interface ExecutionReport {
  /** The document as the agent wrote it, without the marker. */
  text: string;
  /** Recent output of the job, for the reviewers. */
  recentOutput: string;
}

/** Everything a reviewer level is given (issues #537, #543). */
export interface ReviewRequest {
  kind: ReviewKind;
  item: ReviewItem;
  /** The version under review: the newest. */
  version: ReviewVersion;
  /** The job's full prompt: the item, its repository and its context. */
  jobPrompt: string;
  jobGoal?: string;
  /** The owner's standing rules. */
  rules: string;
  /** The review trail so far, every version's. */
  previous: ReviewEntry[];
  /** Where this level stands: `number` of `of` (1 is the lowest). Above level `of` is a person. */
  level: { number: number; of: number };
  jobMachine?: string;
  logins?: RunLogins;
}

/** A reviewer level's verdict on a review item, and its notes: for `request_changes`, what the job is to change. */
export interface ReviewReply {
  verdict: ReviewVerdict;
  notes: string;
  model?: string;
  machine?: { id: string; why: string };
}

export type ReviewActionResult =
  | { ok: true; item: ReviewItem }
  | { ok: false; reason: 'not_found' | 'not_open' | 'not_offered' | 'not_switched'; message: string };

/**
 * Runs one review section's review (issues #537, #543): reviewer levels, lowest first, then a person. Every write is
 * one store.tx and compare-and-set, as for questions. `onDecided` and `onRevise` (constructor options) are called
 * inside the tx that settles the item, so the item and its job change together.
 */
export interface ReviewService {
  readonly kind: ReviewKind;
  /** The stage a new version starts at: the first reviewer level's name, or `human` with none. */
  firstStage(): string;
  /** Start the review of an item's newest version. */
  handle(itemId: string): void;
  /**
   * A person's decision, one the section declares, at any stage: `by` is who. `then` (issue #548): accepting an item
   * whose job is in a switched phase of this kind, what the job does next (thenChoices); refused for any other.
   */
  decide(itemId: string, decision: ReviewDecisionId, by: string, notes?: string, then?: ShiftThen): ReviewActionResult;
  /** A person saw it in the UI: `seenAt` set once. */
  markSeen(itemId: string): ReviewActionResult;
  /** Cancel the open items whose job ended or is gone. Run on each tick and by `recover`. */
  sweep(): void;
  /** Startup: every open item at a reviewer level is reviewed again from there. */
  recover(): void;
  stop(): Promise<void>;
}

/** Every review section's service, by kind. */
export type ReviewServices = Readonly<Record<ReviewKind, ReviewService>>;
