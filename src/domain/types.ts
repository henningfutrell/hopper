// The job-hopper domain vocabulary. Every name here is defined in docs/glossary.md;
// change the glossary in the same commit as any rename.

export type JobId = string;
export type MachineId = string;
export type LaneId = string; // `${machineId}/lane-${n}`

export type JobStatus =
  | 'queued' // accepted, waiting for admission
  | 'held' // the last Decision held it; still waiting, with a reason
  | 'claimed' // a Decision assigned it to a Lane; executor not yet running
  | 'running'
  | 'finished'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['finished', 'failed', 'cancelled'];

/** What an agent pushes. `executor` names a registered Executor; `payload` is opaque to the queue. */
export interface JobSpec {
  executor: string;
  payload: Record<string, unknown>;
  /** 0..100, higher runs first. Default 50. */
  priority?: number;
  /** Short human goal; fed to Jev as `goal`. */
  goal?: string;
  /** Jev `kind` hint: chat | lookup | research | browser | coding | write | account. */
  kind?: string;
  /** Who pushed it (e.g. "grok-bot"). */
  submittedBy?: string;
  /** Pin to a machine; absent = any. */
  machineId?: MachineId;
  /** Free metadata passed to Jev state (cached_artifact, prior_error, same_error_count, ...). */
  meta?: Record<string, unknown>;
}

export interface Job {
  id: JobId;
  spec: JobSpec;
  priority: number; // resolved from spec, default 50
  status: JobStatus;
  /** Latest Jev advice for this job, absent until Jev has classified it. */
  jevAdvice?: JevAdvice;
  /** Set while held: the reason from the last Decision. */
  holdReason?: string;
  /** True once a human approved a job Jev routed to `ask_human`. */
  approved: boolean;
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
}

/** The actions grok-bot-jev's router can return (src/router.py). */
export type JevAction =
  | 'proceed_full'
  | 'reuse_cache'
  | 'stop_retry'
  | 'run_deterministic'
  | 'chat_only'
  | 'ask_human'
  | 'allow_subagent'
  | 'research_capped';

export interface JevAdvice {
  action: JevAction;
  reason: string;
  /** Whether Jev's classifier actually ran (false: kill switch / bypass / fallback). */
  jevUsed: boolean;
  /** Router `details` verbatim: intent, confidences, complexity_0_1, ... */
  details: Record<string, unknown>;
  /** Which advisor produced it: "jev-router" | "fake" | "fallback". */
  source: string;
  at: string;
}

/** shadow: advice is recorded, never changes a Decision. active: advice shapes admission and order. */
export type JevMode = 'shadow' | 'active';

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
}

/** One usage budget reading. `used`/`limit` share a unit; `unit` names it. */
export interface UsageReading {
  source: string;
  /** Machine the budget constrains; absent = applies to every machine. */
  machineId?: MachineId;
  used: number;
  limit: number;
  unit: string;
  /** ISO time the window resets, if known. */
  resetsAt?: string;
  at: string;
}

/** Everything one Decision is made over. Recorded verbatim on the Decision. */
export interface DecisionInputs {
  at: string;
  trigger: string; // "tick" | "job.queued" | "job.finished" | ... — what woke the engine
  jevMode: JevMode;
  machines: MachineSnapshot[];
  lanes: Lane[];
  usage: UsageReading[];
  /** Jobs waiting for admission: status queued or held. */
  waiting: Job[];
  /** Jobs claimed or running. */
  running: Job[];
  policy: DeciderPolicy;
}

export interface DeciderPolicy {
  /** Fraction of a budget used at which a machine stops opening new lanes (0..1). */
  softLimit: number;
  /** Fraction used at which every idle lane closes and no job starts (0..1). */
  hardLimit: number;
  /** Priority added in active mode for cheap Jev classes (chat_only, run_deterministic). */
  jevCheapBoost: number;
  /** An idle lane with no work for it closes only after being idle this long (ms). */
  laneIdleGraceMs: number;
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

/** What Jev would have changed. Always computed; only applied in active mode. */
export interface JevDivergence {
  jobId: JobId;
  advice: JevAction;
  native: 'start' | 'hold';
  withJev: 'start' | 'hold';
  note: string;
}

export interface Decision {
  id: string;
  at: string;
  trigger: string;
  jevMode: JevMode;
  lanes: LanePlan[];
  start: StartPlan[];
  hold: HoldPlan[];
  jev: JevDivergence[];
  /** Plain-language reasons, in the order the decider reached them. */
  reasons: string[];
  inputs: DecisionInputs;
}

// ---- Events ------------------------------------------------------------------------
// Wire type is the dotted form; the glossary carries the domain name (JobQueued, ...).

export type EventType =
  | 'job.queued'
  | 'job.prioritized'
  | 'job.held'
  | 'job.approved'
  | 'job.claimed'
  | 'job.started'
  | 'job.progressed'
  | 'job.finished'
  | 'job.failed'
  | 'job.cancelled'
  | 'job.requeued'
  | 'lane.opened'
  | 'lane.closed'
  | 'decision.made'
  | 'jev.mode_changed';

export const EVENT_TYPES: readonly EventType[] = [
  'job.queued', 'job.prioritized', 'job.held', 'job.approved', 'job.claimed', 'job.started',
  'job.progressed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued',
  'lane.opened', 'lane.closed', 'decision.made', 'jev.mode_changed',
];

export interface DomainEvent<T = Record<string, unknown>> {
  /** Monotonic, assigned by the store on append. */
  seq: number;
  id: string; // uuid
  type: EventType;
  at: string;
  /** Subject ids for filtering: job, lane, machine, decision. */
  jobId?: JobId;
  laneId?: LaneId;
  machineId?: MachineId;
  decisionId?: string;
  data: T;
}

export type NewEvent = Omit<DomainEvent, 'seq' | 'id' | 'at'> & { at?: string };

// ---- Webhooks ----------------------------------------------------------------------

export interface WebhookSubscription {
  id: string;
  url: string;
  /** Event types to deliver; ['*'] = all. */
  events: string[];
  /** HMAC-SHA256 key. Returned once on create, never listed. */
  secret: string;
  active: boolean;
  createdAt: string;
}

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
