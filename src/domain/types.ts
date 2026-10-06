// The hopper domain vocabulary. Every name here is defined in docs/glossary.md;
// change the glossary in the same commit as any rename.
import type { ExecutorUnavailable, QueueOrder } from './plugins.ts';
import type { RoutedBy } from './routing.ts';
import type { UsageReading } from './usage.ts';

export type JobId = string;
export type MachineId = string;
export type LaneId = string; // `${machineId}/lane-${n}`

export type JobStatus =
  | 'queued' // accepted, waiting for admission
  | 'held' // the last Decision held it; still waiting, with a reason
  | 'claimed' // a Decision assigned it to a Lane; executor not yet running
  | 'running'
  | 'waiting_answer' // paused on a question; holds no lane; its pane stays open
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'rejected'; // turned away at the queue gate: kept, never run

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
  /** The routing rule that set this job's machine, executor or priority at intake (issue #18). */
  routedBy?: RoutedBy;
}

export interface Job {
  id: JobId;
  spec: JobSpec;
  priority: number; // resolved from spec, default 50
  status: JobStatus;
  /** The router's advice for this job, absent until the router has answered. */
  advice?: Advice;
  /** Set while held: the reason from the last Decision. */
  holdReason?: string;
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
  /** Executor-owned state (e.g. herdr pane/agent ids), written via ExecutionContext.saveState. */
  executorState?: Record<string, unknown>;
  /** The open question this job waits on (status waiting_answer). */
  questionId?: string;
  /** An answer to deliver on the next claim: the job resumes instead of starting fresh. */
  pendingAnswer?: string;
  /** Machine a resuming job must return to (its pane lives there). */
  resumeOn?: MachineId;
  /** Where the job was pulled from. Absent only for jobs created before phase 3. */
  source?: JobSourceRef;
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

/** shadow: advice is recorded, never changes a Decision. active: advice shapes admission and order. */
export type RouterMode = 'shadow' | 'active';

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
  online: boolean;
  /** Executors this machine can run. */
  executors: string[];
  /** An attached machine: the ssh destination its executors reach it by. Absent → this machine. */
  ssh?: string;
  /** An attached machine's herdr: its binary (absolute, so never its PATH) and hopper's session there. */
  herdr?: { bin: string; session: string };
  /** A container target: the container its executors reach it in, through `docker exec`. */
  docker?: string;
  /** A client target: the variable its token is in (its tunnel's socket is named after the machine id); once probed online, the client release it runs (absent: it predates releases) and whether that is the hopper's (issue #70). */
  client?: { tokenEnv: string; release?: string; current?: boolean };
}

/** Everything one Decision is made over. Recorded verbatim on the Decision. */
export interface DecisionInputs {
  at: string;
  trigger: string; // "tick" | "job.queued" | "job.finished" | ... — what woke the engine
  routerMode: RouterMode;
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
  policy: DeciderPolicy;
}

export interface DeciderPolicy {
  /** Fraction of a budget used at which a machine stops opening new lanes (0..1). */
  softLimit: number;
  /** Fraction used at which every idle lane closes and no job starts (0..1). */
  hardLimit: number;
  /** Priority added in active mode for cheap advice (chat_only, run_deterministic). */
  routerCheapBoost: number;
  /** An idle lane with no work for it closes only after being idle this long (ms). */
  laneIdleGraceMs: number;
  /** Priority added to a job resuming with an answer — it is part done. Both modes. */
  resumeBoost: number;
}

export interface LanePlan {
  machineId: MachineId;
  current: number; // lanes open now (idle + busy + draining)
  target: number;
  /** Lanes to open. Invariant: equals the number of this machine's starts with laneId null. */
  open: number;
  close: LaneId[]; // idle lanes to close now
  drain: LaneId[]; // busy lanes to close when their job ends
  reason: string;
}

export interface StartPlan {
  jobId: JobId;
  laneId: LaneId | null; // null: start on a lane opened by this Decision (engine assigns)
  machineId: MachineId;
  effectivePriority: number;
  reason: string;
}

export interface HoldPlan {
  jobId: JobId;
  reason: string;
}

/** What the router's advice would have changed. Always computed; only applied in active mode. */
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
  routerMode: RouterMode;
  lanes: LanePlan[];
  start: StartPlan[];
  hold: HoldPlan[];
  /** Divergences: jobs where the advice differs from the native verdict. */
  advice: Divergence[];
  /** Plain-language reasons, in the order the decider reached them. */
  reasons: string[];
  inputs: DecisionInputs;
}

// ---- Events ------------------------------------------------------------------------
// Wire type is the dotted form; the glossary carries the domain name (JobQueued, ...).

export const EVENT_TYPES = [
  'job.queued', 'job.prioritized', 'job.held', 'job.approved', 'job.claimed', 'job.started',
  'job.progressed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'job.reattached', 'job.reprioritized',
  'lane.opened', 'lane.closed', 'decision.made', 'router.mode_changed',
  'question.asked', 'question.escalated', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired',
  'update.available', 'update.started', 'update.applied', 'update.failed',
  'plugin.installed', 'plugin.removed',
  'job.accepted', 'job.rejected', 'queue.ordered', 'queue.gate_changed',
] as const;
export type EventType = typeof EVENT_TYPES[number];

/**
 * Payload schema version per event type (docs/schemas/<type>.v<N>.json). Additive field →
 * same version; removed/renamed/retyped field → bump. The store stamps it on append.
 */
export const EVENT_SCHEMA_VERSIONS: Readonly<Record<EventType, number>> = {
  'job.queued': 1, 'job.prioritized': 2, 'job.held': 1, 'job.approved': 1, 'job.claimed': 1,
  'job.started': 1, 'job.progressed': 1, 'job.finished': 1, 'job.failed': 1, 'job.cancelled': 1,
  'job.requeued': 1, 'job.reattached': 1, 'job.reprioritized': 1, 'lane.opened': 1, 'lane.closed': 1,
  'decision.made': 2, 'router.mode_changed': 1, 'question.asked': 1, 'question.escalated': 2,
  'question.answered': 2, 'question.closed': 1, 'question.dismissed': 1, 'question.expired': 1,
  'update.available': 1, 'update.started': 1, 'update.applied': 1, 'update.failed': 1,
  'plugin.installed': 1, 'plugin.removed': 1,
  'job.accepted': 1, 'job.rejected': 1, 'queue.ordered': 1, 'queue.gate_changed': 1,
};

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
  /** The variable the runtime gives the HMAC-SHA256 key in (design.md "Secrets"): a name, never the secret. */
  secretEnv: string;
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
/** `closed`: the owner ended it without answering; the job resumes with the close text (questions/service.ts CLOSED_ANSWER). */
/** `dismissed`: the owner dropped it; nothing is typed into the job, and a job still waiting on it is cancelled. */
export type QuestionStatus = 'open' | 'answered' | 'closed' | 'dismissed' | 'expired' | 'cancelled';

/** Who made an attempt: an escalation level, or the human. */
export type AttemptRole = 'level' | 'human';

/** One entry in a question's trail: an escalation level's reply, or the human's answer. Human attempts carry only the answer. */
export interface QuestionAttempt {
  /** Who: the level's instance name, or `human`. */
  tier: string;
  role: AttemptRole;
  /** The model that ran, as the level reports it, else the configured one. */
  model?: string;
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

export interface Question {
  id: string;
  jobId: JobId;
  text: string;
  recentOutput: string;
  detectedBy: string;
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
  escalatedToHumanAt?: string;
  lastNotifiedAt?: string;
  notifyCount: number;
  /** Human tier: when the question expires and the job fails. */
  expiresAt?: string;
  /** When the owner first saw it in the UI (POST /ui/api/questions/:id/seen). Unseen open questions at the human stage are the nav badge. */
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Sources -----------------------------------------------------------------------

export interface SourceStatus {
  name: string;
  kind: string;
  /** ok: last sync succeeded. error: last sync failed. disabled: configured off. starting: no sync yet. */
  state: 'ok' | 'error' | 'disabled' | 'starting';
  lastSyncAt?: string;
  lastOkAt?: string;
  lastError?: string;
  nextSyncAt?: string;
  /** Eligible items seen by the last discover. */
  itemsSeen: number;
  /** Jobs this source created since the daemon started. */
  jobsCreated: number;
  /** Non-terminal jobs from this source. */
  activeJobs: number;
  /** Source-specific facts for the UI, e.g. { owners, repos, authors, label }. */
  detail: Record<string, unknown>;
}

// ---- Attached machines: src/domain/machines.ts (re-exported here) ------------------------

export type { AttachedMachine, ClientMachine, ContainerMachine, MachineDefaults, MachineDefaultsEdit, MachineEdit, SshMachine, MachineEditOutcome, MachinesConfig } from './machines.ts';

// ---- Routing rules: src/domain/routing.ts; plugins: src/domain/plugins.ts (re-exported here, one vocabulary) ----

export type * from './routing.ts';
export { LIST_ROLES, ROLES, SELECTABLE_ROLES } from './plugins.ts';
export type { Account, ExecutorLaneEffect, MachineLaneEffect, PartAccount, UsageReading, UsageReport, UsageSourceReport, UsageSourceState } from './usage.ts';
export type * from './plugins.ts';

// ---- Queue gate (issue #159): src/domain/queue-gate.ts (re-exported here) ---------------

export type { GateActor, PreSort, PreSortReject, QueueGate, QueueGateMode } from './queue-gate.ts';
export { DEFAULT_QUEUE_GATE, QUEUE_GATE_MODES } from './queue-gate.ts';

// ---- Question gates: src/domain/question-gates.ts (re-exported here) -------------------

export type { QuestionGatesView, RiskRuleView, RulesView } from './question-gates.ts';

// ---- Sign-in: src/domain/sign-in.ts (re-exported here) ------------------------------------

export type { Identity, PasswordAccountView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, SessionUser, SessionView, SignInRealmView, UiRole } from './sign-in.ts';
export { FORM_REALM_TYPES, REALM_TYPES, UI_ROLES, roleAllows } from './sign-in.ts';

// ---- Users (issue #158): src/domain/users.ts (re-exported here) ---------------------------

export type { User, UserAdded, UserView } from './users.ts';
export { OWNER_ID } from './users.ts';

// ---- Self-update (issue #44) ------------------------------------------------------------

export type { InstallInfo, UpdateApply, UpdateChannel, UpdateRelease, UpdateSettings, UpdateState, UpdateStatus } from './update.ts';
export { UPDATE_CHANNELS } from './update.ts';

// ---- gh login (issue #138) -------------------------------------------------------------

/**
 * The gh CLI's login, as GET /api/gh-login reports it: gh's device flow run by the hopper, its
 * device code shown in the UI until the GitHub user approves it at `verificationUri`. gh keeps the
 * token in its own config; the hopper keeps none.
 */
export type GhLoginStatus =
  | { state: 'logged-in'; account?: string }
  | { state: 'logged-out' }
  | { state: 'waiting'; userCode: string; verificationUri: string }
  | { state: 'failed'; error: string }
  | { state: 'unavailable'; reason: string };
