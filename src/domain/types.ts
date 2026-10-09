// The hopper domain vocabulary. Every name here is defined in docs/glossary.md;
// change the glossary in the same commit as any rename.
import type { CleanupDue } from './cleanup.ts';
import type { EventType } from './event-types.ts';
import type { ExecutorUnavailable, QueueOrder } from './plugins.ts';
import type { RoutedBy } from './routing.ts';
import type { DeciderPolicy } from './decider-policy.ts';
import type { UsageReading } from './usage.ts';
import type { JobAssessment, ProblemBlock } from './failures.ts';
import type { PriorityLanesInput } from './priority.ts';
import type { BlastRadiusInput, GatePass } from './blast-radius.ts';

export type JobId = string;
export type MachineId = string;
export type LaneId = string; // `${machineId}/lane-${n}`

export type JobStatus =
  | 'queued' // accepted, waiting for admission
  | 'held' // the last Decision held it; still waiting, with a reason
  | 'claimed' // a Decision assigned it to a Lane; executor not yet running
  | 'running'
  | 'waiting_answer' // paused on a question; holds no lane; its pane stays open
  | 'operator_led' // claimed by an operator, worked by hand outside the hopper; holds no lane, never run (issue #318)
  | 'parked' // taken out of its lane by a person (issue #501): no lane, no pane, no agent; its work tree and agent session kept until re-queued
  | 'finished' | 'failed' | 'cancelled'
  | 'rejected'; // turned away at the queue gate: kept, never run

/**
 * The jobs directory (issue #314): the default work tree, below the home of the job's machine. A job never
 * runs with that home, or anything above it, as its work tree; this directory, and a work tree under it,
 * is made when missing.
 */
export const JOBS_DIR = '~/hopper-jobs';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];

/**
 * Whether a source item whose newest job is this one gets a new job: the job ended (finished,
 * failed, cancelled or rejected) and the source already reported that (so its marker, e.g. `hopper:done` or
 * `hopper:failed`, was written at least once). A source that offers the item again then means a
 * human cleared the marker. Unreported, the item is still the same attempt: a failing report must
 * not loop.
 */
export function isRerunnable(job: Job): boolean {
  return TERMINAL_STATUSES.includes(job.status) && job.sourceState?.sync?.finalReported === true;
}

/** What an agent pushes. `executor` names a registered Executor; `payload` is opaque to the queue. */
export interface JobSpec {
  executor: string;
  payload: Record<string, unknown>;
  /** 0..100, higher runs first. Default 50. */
  priority?: number;
  /** Short human goal; given to the router (grok-bot-jev's router reads it as `goal`). */
  goal?: string;
  /** Kind hint for the router (grok-bot-jev's `kind`): chat | lookup | research | browser | coding | write | account. */
  kind?: string;
  /** Who pushed it (e.g. "grok-bot"). */
  submittedBy?: string;
  /** Pin to a machine; absent = any. */
  machineId?: MachineId;
  /** Free metadata for the router (grok-bot-jev state: cached_artifact, prior_error, same_error_count, ...). */
  meta?: Record<string, unknown>;
  /** The routing rule that set this job's machine, executor, priority or work tree (issue #18), at intake or a later sync (issue #375). */
  routedBy?: RoutedBy;
  /** Asked for a proposal (issue #537): its agent writes one instead of doing the work, and is told so after the job rules. */
  proposal?: true;
}

/** What a job's source and routing rules give its spec (issue #375); `cwd`, `model`: the payload's. */
export interface SpecFromConfig { executor: string; model?: string; cwd?: string; machineId?: MachineId; rule?: string }

export interface Job {
  id: JobId;
  spec: JobSpec;
  priority: number; // resolved from spec, default 50
  status: JobStatus;
  /** The router's advice for this job, absent until the router has answered. */
  advice?: Advice;
  /** Set while held: the reason from the last Decision. */
  holdReason?: string;
  /** Set while queued for want of a lane (issue #381): the lane cap that binds, with its number. Not a hold. */
  waitReason?: string;
  /** True once a human approved a job the router held (`ask_human` and the other router holds). */
  approved: boolean;
  /**
   * False while the job waits at the queue gate (issue #159): held `awaiting acceptance` until the
   * pre-sort or the user accepts it. Absent (jobs from before the gate) or true: accepted.
   */
  accepted?: boolean;
  /** The job's place in the user order (0 first): set when the user orders the queue; ranked jobs run before the rest. */
  userRank?: number;
  laneId?: LaneId;
  progress?: number; // 0..1
  progressMessage?: string;
  result?: unknown;
  error?: string;
  createdAt: string; // ISO
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Incremented on every claim. */
  attempts: number;
  /** The job's work tree on its machine, as its executor reported it (issue #166); absent for an executor with none. */
  workTree?: string;
  /** Where its credential files are kept on its machine (issue #441): each renewal of its connection rewrites them there. Absent: none kept. */
  credentialsDir?: string;
  /** Executor-owned state (e.g. herdr pane/agent ids), written via ExecutionContext.saveState. */
  executorState?: Record<string, unknown>;
  /** The open question this job waits on (status waiting_answer). */
  questionId?: string;
  /** Its proposal (issue #537): while it is open, the job waits on it (status waiting_answer, no question). */
  proposalId?: string;
  /** An answer to deliver on the next claim: the job resumes instead of starting fresh. */
  pendingAnswer?: string;
  /** Machine a resuming job must return to (its pane lives there, or its parked work tree and agent session). */
  resumeOn?: MachineId;
  /**
   * The agent session its executor started the job's agent with (issue #501), so a parked job resumes it
   * (`claude --resume <session>`). Absent: the executor records none, and the job cannot be parked.
   */
  agentSession?: string;
  /**
   * Set when the job was parked (issue #501): its pane and agent ended, its work tree and agent session kept,
   * `from` the status it was parked from. Kept through the re-queue until the resumed run records an outcome:
   * that claim reopens the session instead of typing into a pane.
   */
  parked?: { at: string; from: 'running' | 'waiting_answer' };
  /** What its source and routing rules last gave the spec (issue #375): a part differing from it was set by hand. Absent: the spec. */
  fromConfig?: SpecFromConfig;
  /** Where the job was pulled from. Absent only for jobs created before phase 3. */
  source?: JobSourceRef;
  /** The job this one runs again (a re-run, issue #354): the newest job of its source key when it was created. */
  rerunOf?: JobId;
  /** When the user dismissed this failed job (issue #355): it is no longer a locked entry. */
  dismissedAt?: string;
  /**
   * Set while the job's cleanup is deferred (issue #371): it ended, but its executor could not reach the
   * job's machine to release what it holds there (its pane, its Claude), so that may still run. Tried
   * again on every tick until it goes through; meanwhile a waiting job of the same item is held.
   */
  cleanupDeferred?: { at: string; error: string };
  /** The output tail its executor gave when it failed (issue #509), codes hidden; the assessor's evidence. */
  errorTail?: string;
  /** The failure assessor's judgement of this failed job (issue #509): its decision, summary and reasons. */
  assessment?: JobAssessment;
  /** Let through the blast-radius gate by a person (issue #542): it may run on a gated machine. */
  gatePass?: GatePass;
  /**
   * `sync`: owned by the sync loop (claimReported, reportedQuestions, finalReported,
   * cancelReason). `source`: owned by the adapter; `report()` returns its whole new value,
   * which replaces the old one (never a shallow merge of nested maps).
   */
  sourceState?: { sync?: Record<string, unknown>; source?: Record<string, unknown> };
}

/** The item a job was pulled from. `key` is unique across all jobs (dedupe). */
export interface JobSourceRef {
  /** The configured source name, e.g. "github". */
  source: string;
  kind: string;
  /** Stable unique key — for GitHub, the issue URL. */
  key: string;
  url?: string;
  title?: string;
  /** owner/repo for GitHub. */
  repo?: string;
  number?: number;
  author?: string;
  /** The login the job was taken for (issue #387). Absent on jobs taken before intake by assignee. */
  assignee?: string;
  labels?: string[]; // the item's labels at intake (issue #378); absent on jobs taken before
}

/** The actions a router can advise — grok-bot-jev's router actions (src/router.py). */
export type AdviceAction =
  | 'proceed_full'
  | 'reuse_cache'
  | 'stop_retry'
  | 'run_deterministic'
  | 'chat_only'
  | 'ask_human'
  | 'allow_subagent'
  | 'research_capped';

/** A router's answer for one job. */
export interface Advice {
  action: AdviceAction;
  reason: string;
  /** The router's own details verbatim (gate-router: intent, confidences, gatesAsked, gatesBy, ...). */
  details: Record<string, unknown>;
  /** Who produced it: the router plugin ("gate-router", "pass-through", ...), or "fallback". */
  source: string;
  at: string;
}

export interface Lane {
  id: LaneId;
  machineId: MachineId;
  /** idle: open, no job. busy: running a job. draining: closing once its job ends. */
  state: 'idle' | 'busy' | 'draining';
  jobId?: JobId;
  openedAt: string;
  /** Set when the lane last became idle; cleared when busy. */
  idleSince?: string;
}

/** Point-in-time view of one machine, as polled by the engine. */
export interface MachineSnapshot {
  id: MachineId;
  label: string;
  /** Hard ceiling on lanes this machine may run. */
  maxLanes: number;
  /** Lanes kept for jobs pinned to it (issue #372): jobs with no machine pin use at most its lane cap less these. Absent: 0. */
  reservedLanes?: number;
  online: boolean;
  /** Executors this machine can run. */
  executors: string[];
  /** An attached machine: the ssh destination its executors reach it by. Absent → this machine. */
  ssh?: string;
  /** An attached machine's herdr: hopper's session there, herdr found by name (issue #311); this machine's, the herdr session it was added with (issue #260). */
  herdr?: { session: string };
  /** A container target: the container its executors reach it in, through `docker exec`. */
  docker?: string;
  /** Its work tree (issues #324, #361): every job's there but one a routing rule pinned here with a path; `~` resolves on it. Absent: the jobs directory. */
  workTree?: string;
  /** Why its work tree cannot be made usable, as its last probe found (issue #361): no job is routed to it. Absent: usable, or not probed yet. */
  workTreeProblem?: string;
  /** An attached machine's home, as its probe found it: where `~` in a job's work tree resolves there (issue #323). Absent: not found yet, or this machine. */
  home?: string;
  /** A client target: once probed online, the client release it runs (absent: it predates releases) and whether that is the hopper's (issue #70). */
  client?: { release?: string; current?: boolean };
  /** The disk its home is on, as last read (issue #401); `low` by its thresholds, and then it takes no new job (issue #410). Absent: not read (a container target, a client older than this). */
  disk?: { freeBytes: number; totalBytes: number; low: boolean };
  /** How the sweep treats it (issue #410): how often, and how old an ended job's scratch dir gets there. Absent fields: the defaults. */
  sweep?: { everyMinutes?: number; scratchMaxAgeHours?: number };
}

/** Everything one Decision is made over. Recorded verbatim on the Decision. */
export interface DecisionInputs {
  at: string;
  trigger: string; // "tick" | "job.queued" | "job.finished" | ... — what woke the engine
  machines: MachineSnapshot[];
  lanes: Lane[];
  usage: UsageReading[];
  /** Jobs waiting for admission: status queued or held. */
  waiting: Job[];
  /** Jobs claimed or running. */
  running: Job[];
  /** Configured executors that cannot run; jobs naming one are held. Absent on Decisions stored before phase 5 slice 3. */
  unavailableExecutors: ExecutorUnavailable[];
  /** The queue sorter's order of the waiting jobs (step 6). Absent on Decisions stored before issue #18: today's rule. */
  queueOrder?: QueueOrder;
  /** Ended jobs whose cleanup is running or deferred (issue #371): a waiting job of the same item is held. Absent on Decisions stored before it. */
  cleanupDue?: CleanupDue[];
  /** Open problems that hold or redirect jobs (issue #509). Absent on Decisions stored before it. */
  problems?: ProblemBlock[];
  /** The priority lanes and the high-priority threshold (issue #535). Absent on Decisions stored before it: none. */
  priorityLanes?: PriorityLanesInput;
  /** The machines the blast-radius gate keeps from ordinary placement, and what may pass (issue #542). Absent on Decisions stored before it: none. */
  blastRadius?: BlastRadiusInput;
  policy: DeciderPolicy;
}

export type { DeciderPolicy } from './decider-policy.ts';

export interface LanePlan {
  machineId: MachineId;
  current: number; // lanes open now (idle + busy + draining)
  target: number;
  /** Lanes to open. Invariant: equals the number of this machine's starts with laneId null. */
  open: number;
  close: LaneId[]; // idle lanes to close now
  drain: LaneId[]; // busy lanes to close when their job ends
  reason: string;
  /**
   * Why the machine leaves lanes unused after this Decision (issue #440): the queue gate, usage pacing,
   * reserved lanes, a low disk, a machine that cannot take work, or no job waiting. Absent: every lane is in use.
   */
  idle?: string;
}

export interface StartPlan {
  jobId: JobId;
  laneId: LaneId | null; // null: start on a lane opened by this Decision (engine assigns)
  /** With `laneId` null: the lane to open, a priority lane or one kept off them (issue #535). Absent: the lowest free number. */
  opens?: LaneId;
  machineId: MachineId;
  effectivePriority: number;
  reason: string;
}

export interface HoldPlan {
  jobId: JobId;
  reason: string;
}

/** An admitted job left queued for want of a lane (issue #381), with the lane cap that binds. */
export interface WaitPlan { jobId: JobId; reason: string }

/** What the router's advice changed against the native verdict: a hold, or an order. */
export interface Divergence {
  jobId: JobId;
  advice: AdviceAction;
  native: 'start' | 'hold';
  withAdvice: 'start' | 'hold';
  note: string;
}

export interface Decision {
  id: string;
  at: string;
  trigger: string;
  lanes: LanePlan[];
  start: StartPlan[];
  hold: HoldPlan[];
  /** Admitted jobs no lane is free for: they stay queued (issue #381). Decisions recorded before it lack it. */
  wait: WaitPlan[];
  /** Divergences: jobs where the advice differs from the native verdict. */
  advice: Divergence[];
  /** Plain-language reasons, in the order the decider reached them. */
  reasons: string[];
  inputs: DecisionInputs;
}

// ---- Events ------------------------------------------------------------------------
export * from './event-types.ts';

export interface DomainEvent<T = Record<string, unknown>> {
  /** Monotonic, assigned by the store on append. */
  seq: number;
  /** Payload schema version of this event type (docs/schemas/<type>.v<N>.json). */
  schemaVersion: number;
  id: string; // uuid
  type: EventType;
  at: string;
  /** Subject ids for filtering: job, lane, machine, decision. */
  jobId?: JobId;
  laneId?: LaneId;
  machineId?: MachineId;
  decisionId?: string;
  questionId?: string;
  data: T;
}

export type NewEvent = Omit<DomainEvent, 'seq' | 'id' | 'at' | 'schemaVersion'> & { at?: string };

// ---- Webhooks ----------------------------------------------------------------------

export interface WebhookSubscription {
  id: string;
  /** Unique; the key a UI edit names. Never changed. */
  name: string;
  url: string;
  /** Event types to deliver; ['*'] = all. */
  events: string[];
  /**
   * Only a subscription from before issue #451 with no stored secret: the runtime variable that gives its
   * HMAC-SHA256 key (design.md "Secrets"), a name, never the secret. Gone once a secret is stored.
   */
  secretEnv?: string;
  /** When its stored signing secret last changed (issue #451); the secret itself is never part of a subscription. */
  secretChangedAt?: string;
  active: boolean;
  createdAt: string;
}

export type { WebhooksEdit } from './webhooks.ts';

export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed';

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventSeq: number;
  eventType: EventType;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode?: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Questions ---------------------------------------------------------------------

/** open: being worked on (tier = the stage holding it). answered/expired/cancelled are terminal. */
/** `lapsed`: nobody answered a dialog before its countdown ran out; the agent denied it by itself and went on (issue #376). */
/** `closed`: the owner ended it without answering; the job resumes with the close text (questions/service.ts CLOSED_ANSWER). */
/** `dismissed`: the owner dropped it; nothing is typed into the job, and a job still waiting on it is cancelled. */
export type QuestionStatus = 'open' | 'answered' | 'closed' | 'dismissed' | 'expired' | 'lapsed' | 'cancelled';

/** Who made an attempt: an escalation level, or the human. */
export type AttemptRole = 'level' | 'human';

/** One entry in a question's trail: an escalation level's reply, or the human's answer. Human attempts carry only the answer. */
export interface QuestionAttempt {
  /** Who: the level's instance name, or `human`. */
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
  /** Risk patterns that matched the question or the answer to be typed, independent of any model. */
  riskRules?: string[];
  reason?: string;
  error?: string;
  /** accepted: its answer was typed into the job. escalated: the question went up a level, or to the human. */
  outcome: 'accepted' | 'escalated';
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

export interface Question {
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
  /** Human tier: when it was first and last notified, and how often. */
  escalatedToHumanAt?: string; lastNotifiedAt?: string;
  notifyCount: number;
  /** Human tier: when the question expires and the job fails. */
  expiresAt?: string;
  /** A dialog with a countdown (issue #376): the agent denies it by itself then, unless answered first; it is `lapsed`. */
  lapsesAt?: string;
  /** When the owner first saw it in the UI (POST /ui/api/questions/:id/seen). Unseen open questions at the human stage are the nav badge. */
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Sources: src/domain/sources.ts (re-exported here) ------------------------------------

export type { SourceStatus } from './sources.ts';

// ---- Attached machines: src/domain/machines.ts (re-exported here) ------------------------

export { HERDR_SESSION, HOST_KEY, type AttachedMachine, type ClientMachine, type ConfiguredMachine, type ContainerMachine, type HostKeyOffer, type HostKeyOfferOutcome, type MachineDefaults, type MachineDefaultsEdit, type MachineEdit, type SshMachine, type MachineEditOutcome, type MachinesConfig } from './machines.ts';

// ---- Routing rules: src/domain/routing.ts; plugins: src/domain/plugins.ts (re-exported here, one vocabulary) ----

export type * from './routing.ts';
export type { Account, ExecutorLaneEffect, MachineLaneEffect, PartAccount, UsagePacing, UsageLimitPair, UsageLimits, UsageReading, UsageReport, UsageSourceReport, UsageSourceState } from './usage.ts';
export * from './usage-history.ts';
export type { CleanupDue } from './cleanup.ts';
export * from './plugins.ts';

// ---- Queue gate (issue #159): src/domain/queue-gate.ts (re-exported here) ---------------

export { DEFAULT_QUEUE_GATE, QUEUE_GATE_MODES, type GateActor, type PreSort, type PreSortReject, type QueueGate, type QueueGateMode } from './queue-gate.ts';

// ---- Logins (issue #476): src/domain/logins.ts (re-exported here) ----------------------

export * from './logins.ts';
export * from './proposals.ts';
export * from './failures.ts';
export * from './priority.ts';
export * from './blast-radius.ts';

// ---- Question gates: src/domain/question-gates.ts (re-exported here) -------------------

export type { QuestionGatesView, RiskRuleView, RulesView } from './question-gates.ts';

// ---- Job rules (issue #172): src/domain/job-rules.ts (re-exported here) -------------------

export type { JobRulesView } from './job-rules.ts';

// ---- Sign-in: src/domain/sign-in.ts (re-exported here) ------------------------------------

export type { Identity, PersonView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, SessionEndReason, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole } from './sign-in.ts';
export { DEFAULT_SESSION_LENGTHS, DEVICE_REALM_TYPES, FORM_REALM_TYPES, MAX_SESSION_HOURS, REALM_TYPES, REDIRECT_REALM_TYPES, SESSION_END_REASONS, UI_ROLES, roleAllows } from './sign-in.ts';

// ---- Users (issue #158): src/domain/users.ts (re-exported here) ---------------------------

export { ENDED_STATUSES, IN_FLIGHT_STATUSES, ADMIN_ID, type InstanceTotals, type UsageTotal, type User, type UserAdded, type UserView } from './users.ts';

// ---- Self-update (issue #44) ------------------------------------------------------------

export { isUpdateChannel, UPDATE_CHANNELS, type InstallInfo, type InstallKind, type UpdateApply, type UpdateChannel, type UpdateSettings, type UpdateState, type UpdateStatus, type VersionEntry, type VersionHistory } from './update.ts';

// ---- Connected accounts (issue #214): src/domain/connected-accounts.ts --------------------------

export { CONNECTED_ACCOUNT_PROVIDERS, CONNECTED_VIA, type AppInstallation, type ConnectedAccountProvider, type ConnectedAccountStatus } from './connected-accounts.ts';
