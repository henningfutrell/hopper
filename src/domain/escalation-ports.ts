// The escalation levels' seams, apart from ports.ts for its size and re-exported there: what a level is given to
// answer a question, and to review a proposal (issue #537, design.md "Proposals"); the proposal an executor reports;
// the proposal review.
import type { RunLogins } from './ports.ts';
import type { Proposal, ProposalReview, ProposalVersion, Question, QuestionAttempt, ReviewVerdict } from './types.ts';

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
  /** The model that ran, as its provider reports it (the trail shows it in place of the configured alias). */
  model?: string;
  /** The machine it ran on and why, when the level named none and picked it (issue #442): on the trail. */
  machine?: { id: string; why: string };
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
   * Review a proposal as a reviewer level (issue #537). Never throws by contract; the proposal service fails closed
   * all the same: an error or anything malformed escalates. Absent: the level cannot review, and every proposal it
   * gets escalates.
   */
  review?(req: ReviewRequest, signal: AbortSignal): Promise<ReviewReply | { error: string }>;
}

/** A proposal the agent wrote instead of doing the work (issue #537), ended with HOPPER_PROPOSAL. */
export interface ExecutionProposal {
  /** The proposal as the agent wrote it, without the marker. */
  text: string;
  /** Recent output of the job, for the reviewers. */
  recentOutput: string;
}

/** Everything a reviewer level is given (issue #537). */
export interface ReviewRequest {
  proposal: Proposal;
  /** The version under review: the newest. */
  version: ProposalVersion;
  /** The job's full prompt: the item, its repository and its context. */
  jobPrompt: string;
  jobGoal?: string;
  /** The owner's standing rules. */
  rules: string;
  /** The review trail so far, every version's. */
  previous: ProposalReview[];
  /** Where this level stands: `number` of `of` (1 is the lowest). Above level `of` is a person. */
  level: { number: number; of: number };
  jobMachine?: string;
  logins?: RunLogins;
}

/** A reviewer level's verdict on a proposal, and its notes: for `request_changes`, what the job is to change. */
export interface ReviewReply {
  verdict: ReviewVerdict;
  notes: string;
  model?: string;
  machine?: { id: string; why: string };
}

export type ProposalActionResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'not_found' | 'not_open'; message: string };

/**
 * Runs the proposal review (issue #537): reviewer levels, lowest first, then a person. Every write is one store.tx and
 * compare-and-set, as for questions. `onDecided` and `onRevise` (constructor options) are called inside the tx that
 * settles the proposal, so the proposal and its job change together.
 */
export interface ProposalService {
  /** The stage a new version starts at: the first reviewer level's name, or `human` with none. */
  firstStage(): string;
  /** Start the review of a proposal's newest version. */
  handle(proposalId: string): void;
  /** A person accepts it, at any stage: `by` is who. */
  accept(proposalId: string, by: string, notes?: string): ProposalActionResult;
  /** A person rejects it, with why. */
  reject(proposalId: string, by: string, notes: string): ProposalActionResult;
  /** A person sends it back to the job with what to change. */
  requestChanges(proposalId: string, by: string, notes: string): ProposalActionResult;
  /** A person saw it in the UI: `seenAt` set once. */
  markSeen(proposalId: string): ProposalActionResult;
  /** Cancel the open proposals whose job ended or is gone. Run on each tick and by `recover`. */
  sweep(): void;
  /** Startup: every open proposal at a reviewer level is reviewed again from there. */
  recover(): void;
  stop(): Promise<void>;
}
