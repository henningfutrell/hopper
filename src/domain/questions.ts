// The question's types (design.md "Question pipeline"), apart from types.ts for its size; re-exported there.
import type { Confidence, QuestionCorrection } from './auto-answer.ts';
import type { RiskCategory, RiskDecision, RiskLevel } from './minor-decisions.ts';
import type { AttemptPhaseFields, QuestionPhaseFields } from './phase.ts';
import type { ThreadAsk } from './thread-ask.ts';
import type { Tldr } from './tldr.ts';
import type { JobId, LaneId, MachineId } from './types.ts';

/** open: being worked on (tier = the stage holding it). answered/expired/cancelled are terminal. */
/** `lapsed`: nobody answered a dialog before its countdown ran out; the agent denied it by itself and went on (issue #376). */
/** `closed`: the owner ended it without answering; the job resumes with the close text (questions/service.ts CLOSED_ANSWER). */
/** `dismissed`: the owner dropped it; nothing is typed into the job, and a job still waiting on it is cancelled. */
export type QuestionStatus = 'open' | 'answered' | 'closed' | 'dismissed' | 'expired' | 'lapsed' | 'cancelled';

/** Who made an attempt: the fixed answers (issue #629), an escalation level, Jev (a decider call, issue #550), the human, or a fork whose accepted result answered the question (issue #548). */
export type AttemptRole = 'fixed' | 'level' | 'jev' | 'human' | 'fork';

/** One entry in a question's trail: an escalation level's reply, or the human's answer. Human attempts carry only the answer. */
export interface QuestionAttempt extends AttemptPhaseFields {
  /** Who: `fixed`, the level's instance name, `jev`, `human`, or `fork:<job id>`. */
  tier: string;
  role: AttemptRole;
  /** The model that ran, as the level reports it, else the configured one. */
  model?: string;
  /** The machine the level ran on and why, when it named none and picked it (issue #442). */
  machine?: { id: string; why: string };
  startedAt: string;
  finishedAt?: string;
  /** The level's answer (escalating: its recommendation), or the human's answer. */
  answer?: string;
  /** Rows stored before escalation levels only: the answerer judged its draft settled. */
  confident?: boolean;
  /** Rows stored before slice 2 only: the answerer judged risk itself. */
  risky?: boolean;
  /** The level's reply, when it returned a schema-valid one: true sent the question up. */
  escalate?: boolean;
  /** How sure the level said it is of its answer (issue #632); absent: it did not say, which meets no threshold. */
  confidence?: Confidence;
  /** Risk patterns that matched the question or the answer to be typed, independent of any model. */
  riskRules?: string[];
  /** How the answer was checked for risk (issue #679): the keyword risk rules or the Decider, and the Decider's decision. */
  riskCheck?: RiskCheck;
  /** Everything that held the level's answer back from the job (issue #679), strongest first; absent: nothing held it. */
  holds?: AnswerHold[];
  reason?: string;
  error?: string;
  /** accepted: its answer was typed into the job. escalated: the question went up a level, or to the human. */
  outcome: 'accepted' | 'escalated';
}

/** Why a question came to a person (issue #679). */
/**
 * Why a screen of Claude's with no credential goes to the job's answerers (issue #533): the start of its question's text. A
 * tool sign-in from the hopper that completes on the question's machine answers it (issue #1128, `src/questions/signed-out.ts`).
 */
export const NOT_SIGNED_IN = 'Claude is not signed in on this machine: sign it in from Accounts in the hopper or on the machine, or give it CLAUDE_CODE_OAUTH_TOKEN, then answer';
/** What Claude's login screen shows (issue #533): a question of it is the person's, since an answer is typed into its options. */
export const LOGIN_SCREEN_MARK = 'Select login method';
/** Who answers a not-signed-in question when the tool sign-in on its machine completed (issue #1128): its trail's tier and `answeredBy`. */
export const SIGNED_IN_BY = 'sign-in';
/** The answer it gets: at Claude's prompt nothing is typed, and the job's text goes once Claude shows it is signed in. */
export const SIGNED_IN_ANSWER = 'Claude is signed in on this machine now.';
/**
 * Who answers a not-signed-in question when the hopper moves its job to a machine signed in (issue #1211, design.md "The
 * signed-out move"): its trail's tier and `answeredBy`.
 */
export const SIGNED_OUT_MOVE_BY = 'signed-out-move';
/** The answer it gets: what a job resuming elsewhere is told after its brief. */
export const signedOutMoveAnswer = (from: string, service: string): string =>
  `${service} was signed out on machine ${from}. The hopper moved this job to a machine where ${service} is signed in.`;

export const ESCALATION_REASONS = ['guard', 'low_confidence', 'no_answer', 'frontier_escalated', 'high_priority', 'auto_answer_off', 'fork'] as const;
/**
 * `guard`: a risk rule or the consequential guard held an answer back on purpose; `low_confidence`: the top level was not
 * sure enough; `no_answer`: no level gave an answer (it failed, gave none, or there are no levels); `frontier_escalated`:
 * the top level sent it up; `high_priority`: its job is high priority; `auto_answer_off`: auto-answer is off; `fork`: it
 * waits for a fork's result.
 */
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/**
 * One thing that held a level's answer back from the job (issue #679): every one is recorded, not only the first.
 * `guard`: risk rules (`by: 'risk'`) or the consequential guard (`by: 'guard'`), the names that matched in `guards`;
 * `high_priority`: its job is high priority and the user holds those; `auto_answer_off`; `low_confidence`: the level's
 * `confidence` (absent: it gave none) below the `threshold`.
 */
export interface AnswerHold {
  reason: 'guard' | 'high_priority' | 'auto_answer_off' | 'low_confidence';
  by?: 'risk' | 'guard';
  guards?: string[];
  confidence?: Confidence;
  threshold?: Confidence;
  /** A risk hold the Decider made (issue #679), in place of `guards`: what it decided, or why it could not. */
  decider?: DeciderRiskHold;
}

/**
 * The Decider holds an answer for its risk (issue #679): a `real` risk and its `categories`, a `confidence` (0..1) below
 * its `threshold`, or an `error` — it failed or timed out, and the question is held to be safe.
 */
export interface DeciderRiskHold { risk?: RiskLevel; categories?: RiskCategory[]; confidence?: number; threshold: number; error?: string }

/**
 * How a level's answer was checked for risk (issue #679). `rules`: the keyword risk rules decided — the Decider is off,
 * has no TypeSafe API key, or is in shadow (`shadow`: its decision is only recorded). `decider`: the Decider decided. Its
 * `decision`, or the `error` it failed with, when it was asked.
 */
export interface RiskCheck { by: 'rules' | 'decider'; shadow?: boolean; decision?: RiskDecision; error?: string }

/** A hold as a person is told it: each guard with what it catches. */
export type EscalationHold = Omit<AnswerHold, 'guards'> & { guards?: GuardHit[] };

/** A guard that held the answer back: a risk rule's or the consequential guard's name, and what it catches. */
export interface GuardHit { name: string; describe: string }

/** Why a question reached the human stage and what the levels recommended (issue #679); set when it gets there. */
export interface Escalation {
  reason: EscalationReason;
  /** The guards that matched, across every guard hold. */
  guards?: GuardHit[];
  /** Every hold on the answer that sent it here (issue #679), strongest first; `reason` is the first one's. Absent: no level's answer was held. */
  holds?: EscalationHold[];
  /** The last answer a level, Jev or the fixed answers gave on the trail: who, what, and how sure. */
  recommendation?: { by: string; answer: string; confidence?: Confidence };
  /** How that answer was checked for risk (issue #679). Absent: it was not (no level answered, or before this was recorded). */
  riskCheck?: RiskCheck;
}

/**
 * The raising machine (issue #485): the machine a question was asked on, its name (label) then, and the
 * lane — a snapshot taken when it is asked, kept as it was after the job moves or the machine is renamed
 * or removed. Distinct from `QuestionAttempt.machine`, where an escalation level ran.
 */
export interface RaisedBy {
  machineId: MachineId;
  /** The machine's label when the question was asked; absent when it was not known. */
  name?: string;
  laneId?: LaneId;
}

export interface Question extends QuestionPhaseFields {
  id: string;
  jobId: JobId;
  text: string;
  recentOutput: string;
  detectedBy: string;
  /** Where it was asked. Absent: asked before this was recorded, with nothing to fill it from (issue #485). */
  raisedBy?: RaisedBy;
  status: QuestionStatus;
  /**
   * The stage holding the question (or the last one that held it): an escalation level's instance
   * name, or `human`.
   */
  tier: string;
  attempts: QuestionAttempt[];
  answer?: string;
  /** Whose answer was typed: the level instance that answered, or `human` (also for a closed question). */
  answeredBy?: string;
  /** A person corrected a level's auto-answer (issue #632): `answer` is the correction now, and this keeps what it replaced. */
  corrected?: QuestionCorrection;
  /** A risk rule or the consequential guard sent it to a person (issue #650): its job never parks by itself. */
  keptBy?: 'risk' | 'guard';
  /** Its place on its issue thread (issue #435); absent: not asked there. */
  thread?: ThreadAsk;
  /** Why it came to a person (issue #679). Absent: not at the human stage yet, or sent there before this was recorded. */
  escalation?: Escalation;
  /** Human tier: when it was first and last notified, and how often. */
  escalatedToHumanAt?: string; lastNotifiedAt?: string;
  /**
   * Human tier: when it began to wait on a person again — its job re-queued from parked, or the fork's item rejected
   * (issue #692). Auto-park counts from it; absent, from `escalatedToHumanAt`.
   */
  waitRestartedAt?: string;
  notifyCount: number;
  /** Human tier: when the question expires and the job fails. */
  expiresAt?: string;
  /** A dialog with a countdown (issue #376): the agent denies it by itself then, unless answered first; it is `lapsed`. */
  lapsesAt?: string;
  /** When the owner first saw it in the UI (POST /ui/api/questions/:id/seen). Unseen open questions at the human stage are the nav badge. */
  seenAt?: string;
  /** Its TL;DR (issue #569), once a long question has one. */
  tldr?: Tldr;
  createdAt: string;
  updatedAt: string;
}
