// Seams. Everything the engine talks to that is not pure domain logic sits behind one of
// these. Adapters live in src/{executors,machines,usage,jev,store,webhooks}.

import type {
  DomainEvent, Decision, EventType, Job, JobId, JobSpec, JobStatus, JevAdvice, JevMode, Lane,
  JobSourceRef, LaneId, MachineId, MachineSnapshot, NewEvent, Question, QuestionAttempt, QuestionStatus,
  AnswerTier, SourceStatus, UsageReading, WebhookDelivery, WebhookSubscription,
} from './types.ts';

// ---- Execution -----------------------------------------------------------------------

export interface ExecutionContext {
  job: Job;
  laneId: LaneId;
  /**
   * Aborted on cancel or daemon shutdown; `signal.reason` is the string `'cancel'` or
   * `'shutdown'`. On cancel an executor stops the work and releases it; on shutdown it
   * returns promptly and leaves external work (a herdr pane) as it is.
   */
  signal: AbortSignal;
  /** Report progress 0..1 with an optional message. Emits job.progressed. */
  progress(fraction: number, message?: string): void;
  /**
   * Persist executor-owned state on the job (`job.executorState`) as soon as it exists — e.g.
   * the herdr pane a job runs in — so restart recovery and resume can find it.
   */
  saveState(state: Record<string, unknown>): void;
}

/** What the executor needs answered before the job can continue. */
export interface ExecutionQuestion {
  /** The question as the agent asked it. */
  text: string;
  /** Recent output of the job (pane tail), for whoever answers. */
  recentOutput: string;
  /** How it was detected: "marker" | "blocked" | "idle". */
  detectedBy: string;
}

export type ExecutionOutcome =
  | { kind: 'finished'; result: unknown }
  | { kind: 'failed'; error: string }
  /** The job is paused on a question. Its executor state (saveState) must allow resume. */
  | { kind: 'question'; question: ExecutionQuestion };

/**
 * Runs one job on one lane. `name` matches JobSpec.executor: "test" (built in) and
 * "herdr-claude" (Claude Code in a herdr pane).
 * Must resolve (never reject) — a thrown error is converted to { kind: 'failed' } by the
 * engine, but adapters should report their own failures.
 */
export interface Executor {
  readonly name: string;
  /**
   * Safe to run again from scratch after a daemon restart? Default true. A non-idempotent
   * job interrupted by a restart is cleaned up and failed, never re-run.
   */
  readonly idempotent?: boolean;
  /** Validate a payload at push time; return an error string or null. */
  validate(payload: Record<string, unknown>): string | null;
  run(ctx: ExecutionContext): Promise<ExecutionOutcome>;
  /**
   * Continue a job that returned `question`: deliver `answer` (from `ctx.job.executorState`)
   * and run until the next outcome. Absent → the executor never asks questions.
   */
  resume?(ctx: ExecutionContext, answer: string): Promise<ExecutionOutcome>;
  /**
   * Release whatever a job holds outside the process (close its pane). Called when a
   * waiting_answer job is cancelled or expires, and by restart recovery for jobs that were
   * running. Must not throw; idempotent.
   */
  cleanup?(job: Job): Promise<void>;
}

// ---- Inputs the decider is made over ---------------------------------------------------

/** A pluggable source of machines. The local laptop is one; a remote host would be another. */
export interface MachineSource {
  list(): Promise<MachineSnapshot[]>;
}

/** A pluggable usage-budget source. Returns zero or more readings per poll. */
export interface UsageSource {
  readonly name: string;
  poll(): Promise<UsageReading[]>;
}

/** Jev, as job-hopper consumes it: classify one job, return advice. Never throws. */
export interface JevAdvisor {
  readonly name: string;
  advise(job: Job): Promise<JevAdvice>;
}

export interface Clock {
  now(): Date;
}

// ---- Questions -----------------------------------------------------------------------

/** Everything an answering tier is given. */
export interface AnswerRequest {
  question: Question;
  /** The job's full prompt. */
  jobPrompt: string;
  jobGoal?: string;
  /** the owner's standing rules, read from the rules file at ask time. */
  rules: string;
  /** Earlier tiers' attempts, so a later tier sees why it was escalated. */
  previous: QuestionAttempt[];
}

/** The structured contract every model tier returns. */
export interface AnswerVerdict {
  answer: string;
  confident: boolean;
  risky: boolean;
  reason: string;
}

/** One model tier (opus, fable). Never throws: failures come back as `{ error }`. */
export interface Answerer {
  readonly tier: Exclude<AnswerTier, 'human'>;
  /** The model name it runs, for the log. */
  readonly model: string;
  answer(req: AnswerRequest, signal: AbortSignal): Promise<AnswerVerdict | { error: string }>;
}

export type IdGen = () => string;

export interface ExecutorRegistry {
  get(name: string): Executor | undefined;
  names(): string[];
}

/** A usage source whose readings can be set by hand — the fake, driven by PUT /api/usage/fake. */
export interface SettableUsageSource extends UsageSource {
  /** Replace the reading for (machineId ?? global); returns all current readings. */
  set(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export interface WebhookDispatcher {
  /** Subscribe to the EventLog (create deliveries) and start the due-delivery sweep. */
  start(): void;
  /** Stop the sweep; wait for in-flight requests (bounded by their timeout). */
  stop(): Promise<void>;
  /** Called on every delivery state change. Feeds SSE `delivery.updated`. */
  onDeliveryUpdated(listener: (delivery: WebhookDelivery) => void): () => void;
}

export type AnswerByHumanResult =
  | { ok: true; question: Question }
  | { ok: false; reason: 'not_found' | 'not_open' };

/**
 * Runs the escalation chain. Every write is one store.tx and compare-and-set: it applies only
 * if the question is still `open` and (for a model result) its `tier` is the tier that
 * produced it. `onAnswered` / `onExpired` (constructor options) are synchronous and called
 * INSIDE that same tx, so question and job change together or not at all.
 */
export interface QuestionService {
  /** Start the chain for a newly asked question (tier opus). */
  handle(questionId: string): void;
  answerByHuman(questionId: string, answer: string): AnswerByHumanResult;
  /** Synchronous; call inside the caller's tx. Aborts an in-flight tier, clears timers. */
  cancel(questionId: string): void;
  /** Startup: re-run open model tiers, re-arm human timers, expire overdue ones. */
  recover(): void;
  stop(): Promise<void>;
}

// ---- Job sources (the hopper pulls; nothing pushes) -----------------------------------

/** One eligible item a source offers. Becomes at most one job, deduped by `key`. */
export interface SourceItem {
  key: string;
  url: string;
  title: string;
  /** The raw item text (issue body). */
  body: string;
  /**
   * The full prompt sent to the job: `body` followed by the item context (repo, number, URL,
   * title, labels, author, priority and where it came from, project item, recent comments)
   * and instructions for commenting back. Built by the source.
   */
  prompt: string;
  /** Environment for the job's process, e.g. HOPPER_ISSUE_URL, HOPPER_REPO, HOPPER_ISSUE_NUMBER. */
  env: Record<string, string>;
  author: string;
  priority: number;
  /** Where `priority` came from, e.g. "project:Priority=P1", "label:hopper:p0", "default". */
  priorityReason: string;
  /** Working directory for the job (absolute). */
  cwd: string;
  labels: string[];
  repo?: string;
  number?: number;
  /** Executor for the job (from source config), and an optional model. */
  executor: string;
  model?: string;
  /**
   * Set when the item cannot become a runnable job (e.g. "empty issue body"). `ingest` then
   * creates the job and fails it in one tx (job.queued + job.failed), so it is claimed and
   * reported failed once — never retried every poll. An executor rejecting the payload is
   * treated the same way.
   */
  invalid?: string;
}

/** What a source observed about a job it owns. */
export type SourceSignal =
  | { kind: 'cancel'; jobId: JobId; reason: string }
  | { kind: 'answer'; jobId: JobId; questionId: string; answer: string; author: string; url?: string };

/** What happened to a job, reported back to its source. */
export type SourceReport =
  | { kind: 'claimed'; job: Job }
  | { kind: 'progress'; job: Job; message: string }
  | { kind: 'question'; job: Job; question: Question }
  | { kind: 'answered'; job: Job; question: Question }
  | { kind: 'finished'; job: Job }
  | { kind: 'failed'; job: Job }
  | { kind: 'cancelled'; job: Job };

export interface JobSource {
  readonly name: string;
  readonly kind: string;
  /** Facts for SourceStatus.detail. */
  describe(): Record<string, unknown>;
  /** Eligible open items (allowlisted author, labelled, not already done/failed). */
  discover(): Promise<SourceItem[]>;
  /** Signals for this source's non-terminal jobs: cancellations and human answers. */
  check(active: Job[]): Promise<SourceSignal[]>;
  /**
   * Tell the source what happened. Returns the WHOLE new `job.sourceState.source` object
   * (it replaces the old one). Idempotent: before posting, the adapter looks for its own
   * earlier comment with the same hidden marker and reuses it, so a retry after a crash never
   * duplicates. Throws SourceError; `permanent: true` means never retry (404/410/403 on the
   * item, oversized body), `false` means retry on a later sync.
   */
  report(report: SourceReport): Promise<Record<string, unknown>>;
}

export class SourceError extends Error {
  readonly permanent: boolean;
  readonly status?: number;
  constructor(message: string, permanent: boolean, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.permanent = permanent;
    if (status !== undefined) this.status = status;
  }
}

/**
 * What the sync loop may do to the hopper. Engine-owned: every method is one store.tx with
 * compare-and-set on the job's current status.
 */
export interface SourceHost {
  store: Store;
  /** Create the job for an item (dedupe by key). null when the key already has a job. */
  ingest(item: SourceItem, source: { name: string; kind: string }): Job | null;
  cancel(jobId: JobId, reason: string): void;
  answer(questionId: string, answer: string): AnswerByHumanResult;
  /** Apply only if the job is queued/held and the priority differs; emits job.reprioritized. */
  reprioritize(jobId: JobId, to: number, reason: string): boolean;
  /** Replace sourceState in one tx that re-reads the job. */
  setSourceState(jobId: JobId, state: { sync?: Record<string, unknown>; source?: Record<string, unknown> }): void;
}

/**
 * Discovery is re-run every poll; for items that already have a waiting job the sync loop
 * compares `priority` and re-prioritizes the job (event `job.reprioritized`).
 */
/** The sync loop's view, for /api/sources and SSE `source.updated`. */
export interface SourceRegistry {
  statuses(): SourceStatus[];
  onStatus(listener: (status: SourceStatus) => void): () => void;
}

// ---- Persistence -----------------------------------------------------------------------

export interface JobFilter {
  status?: JobStatus[];
  limit?: number;
}

export interface JobRepository {
  /** With `source`, its key must be unique: a duplicate key throws DuplicateSourceKeyError. */
  create(spec: JobSpec, priority: number, source?: JobSourceRef): Job;
  get(id: JobId): Job | undefined;
  getBySourceKey(key: string): Job | undefined;
  list(filter?: JobFilter): Job[];
  /** Shallow-merge patch; a key present with value `undefined` clears that field. Bumps updatedAt. */
  update(id: JobId, patch: Partial<Omit<Job, 'id' | 'spec' | 'createdAt'>>): Job;
}

export interface LaneRepository {
  list(machineId?: MachineId): Lane[];
  /** Opens the lowest free lane number for the machine. */
  open(machineId: MachineId): Lane;
  update(id: LaneId, patch: Partial<Omit<Lane, 'id' | 'machineId' | 'openedAt'>>): Lane;
  close(id: LaneId): void;
}

export interface DecisionRepository {
  save(decision: Decision): void;
  get(id: string): Decision | undefined;
  /** Newest first. */
  list(limit?: number): Decision[];
}

/**
 * Append-only event log. append assigns seq/id/at. Listeners are notified only after the
 * OUTERMOST transaction commits (immediately when no transaction is open), and never for a
 * rolled-back append. Listeners must not re-enter the engine synchronously — schedule work
 * with setImmediate/queueMicrotask.
 */
export interface EventLog {
  append(event: NewEvent): DomainEvent;
  /** Events with seq > afterSeq, oldest first. */
  since(afterSeq: number, limit?: number): DomainEvent[];
  /** Newest first. */
  recent(limit?: number, types?: EventType[]): DomainEvent[];
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

export interface WebhookRepository {
  /** Insert or replace by `name` (webhooks.yaml is the source of truth). */
  upsertByName(input: { name: string; url: string; events: string[]; secret: string; active: boolean }): WebhookSubscription;
  get(id: string): WebhookSubscription | undefined;
  list(): WebhookSubscription[];
  /** Deletes the subscription and marks its pending/retrying deliveries `failed`. */
  delete(id: string): boolean;
  /** status `pending`, attempts 0, nextAttemptAt = now. */
  createDelivery(subscriptionId: string, event: DomainEvent): WebhookDelivery;
  updateDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'subscriptionId' | 'eventSeq' | 'eventType' | 'createdAt'>>): WebhookDelivery;
  /** Deliveries due at or before `now`: status pending|retrying and nextAttemptAt <= now. */
  dueDeliveries(now: Date): WebhookDelivery[];
  listDeliveries(filter?: { subscriptionId?: string; limit?: number }): WebhookDelivery[];
}

export interface QuestionRepository {
  create(input: { jobId: JobId; text: string; recentOutput: string; detectedBy: string }): Question;
  get(id: string): Question | undefined;
  /** Newest first. */
  list(filter?: { status?: QuestionStatus[]; jobId?: JobId; limit?: number }): Question[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Question, 'id' | 'jobId' | 'createdAt' | 'attempts'>>): Question;
  /** Append one tier attempt to the question's trail. */
  addAttempt(id: string, attempt: QuestionAttempt): Question;
}

export interface SettingsRepository {
  getJevMode(): JevMode | undefined;
  setJevMode(mode: JevMode): void;
}

/** The whole store. One SQLite file; repositories share one connection. */
export interface Store {
  jobs: JobRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog;
  webhooks: WebhookRepository;
  questions: QuestionRepository;
  settings: SettingsRepository;
  /** Run fn in one transaction. Re-entrant: a nested tx joins the outer one. Throw = rollback. */
  tx<T>(fn: () => T): T;
  close(): void;
}
