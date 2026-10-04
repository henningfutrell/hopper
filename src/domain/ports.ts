// Seams. Everything the engine talks to that is not pure domain logic sits behind one of
// these. Adapters live in src/{executors,machines,usage,plugins,store,webhooks}.

import type {
  Advice, DomainEvent, Decision, EventType, ExecutorUnavailable, Job, JobId, JobSpec, JobStatus, Lane, MachineEdit, MachineEditOutcome, MachinesConfig, PluginsEdit, PluginsEditOutcome, PluginsReport, RouterMode, RouterStatus,
  RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule,
  JobSourceRef, LaneId, MachineId, MachineSnapshot, NewEvent, Question, QuestionAttempt, QuestionStatus,
  SourceStatus, UsageReading, UsageSourceState, WebhookDelivery, WebhookSubscription,
} from './types.ts';

// ---- Execution -----------------------------------------------------------------------

export interface ExecutionContext {
  job: Job;
  laneId: LaneId;
  /** The machine the lane is on: an executor that runs work outside the process runs it there. */
  machine: MachineSnapshot;
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

/** What `Executor.answeredInPane` saw: the typed answer (if readable) and the state to reattach with. */
export interface PaneAnswer { answer?: string; executorState: Record<string, unknown> }

/**
 * Runs one job on one lane. `name` matches JobSpec.executor: "test" (built in) and
 * "herdr-claude" (Claude Code in a herdr pane).
 * Must resolve (never reject) — a thrown error is converted to { kind: 'failed' } by the
 * engine, but adapters should report their own failures.
 */
export interface Executor {
  readonly name: string;
  /**
   * Safe to run again from scratch after a daemon restart? Default true. A non-idempotent job
   * running at a restart is never re-run: it is reattached (below) or cleaned up and failed.
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
   * Restart recovery, before anything is written: is the work of this `running` job still alive
   * outside the process (its pane and agent), so `reattach` can watch it? Absent → never. Must
   * not throw (an error is `false`).
   */
  canReattach?(job: Job): Promise<boolean>;
  /**
   * Continue a job that was running when the daemon stopped, from the present state of its
   * external work (`ctx.job.executorState`), until the next outcome. Called only after
   * `canReattach` said true; present exactly when `canReattach` is.
   */
  reattach?(ctx: ExecutionContext): Promise<ExecutionOutcome>;
  /**
   * A `waiting_answer` job whose question the owner answered outside the hopper (typed into its
   * pane): its work runs again. Returns the typed text when it can be read reliably, and the
   * executor state that lets `reattach` watch the new turn; null while still parked. Absent →
   * never. Must not throw (an error is null). The engine polls it on every tick.
   */
  answeredInPane?(job: Job): Promise<PaneAnswer | null>;
  /**
   * Release whatever a job holds outside the process (close its pane). Called when a
   * waiting_answer job is cancelled or expires, and by restart recovery for running jobs it
   * fails. Must not throw; idempotent.
   */
  cleanup?(job: Job): Promise<void>;
}

// ---- Inputs the decider is made over ---------------------------------------------------

/** A pluggable source of machines. The local laptop is one; a remote host would be another. */
export interface MachineSource {
  list(): Promise<MachineSnapshot[]>;
}

/**
 * A pluggable usage-budget source. Returns zero or more readings per poll. Every Decision polls
 * every usage source: `poll` must answer from what it already has, never wait on a slow read.
 */
export interface UsageSource {
  readonly name: string;
  poll(): Promise<UsageReading[]>;
  /** When it last read, why it has no readings, and the account it reads them for. */
  state?(): UsageSourceState;
  /** Stop background work (timers, a child process). Called once, at shutdown. */
  stop?(): void;
}

/** What a notifier is given at start: the event log's live feed, and the job an event names. */
export interface NotifierEvents {
  /** Called after each append (listeners must not re-enter synchronously: defer the work). Returns the unsubscribe. */
  subscribe(listener: (event: DomainEvent) => void): () => void;
  job(id: JobId): Job | undefined;
}

/** The notifier role: tells something outside about events. Started once, stopped at shutdown. */
export interface Notifier {
  readonly name: string;
  start(events: NotifierEvents): void;
  /** Unsubscribes and settles in-flight work. */
  stop(): Promise<void>;
}

/** The router role: advise on one job. Never throws (a failure is advice with `source: fallback`). */
export interface Router {
  readonly name: string;
  advise(job: Job): Promise<Advice>;
}

/** One waiting job as the queue sorter sees it: the job and its effective priority (the decider's notion). */
export interface QueueEntry {
  job: Job;
  effectivePriority: number;
}

/**
 * The queue-sorter role: orders the waiting jobs. Synchronous and pure in spirit: called once per
 * Decision while the engine gathers inputs. Returns job ids; ids it leaves out follow, by the
 * decider's own rule. Throwing or returning anything but distinct ids of the given jobs is a
 * fallback to `priority` for that call.
 */
export interface QueueSorter {
  readonly name: string;
  sort(entries: readonly QueueEntry[]): JobId[];
}

/** What the HTTP edge reads about plugins: the router's status and GET /api/plugins. */
export interface PluginsView {
  routerStatus(): RouterStatus;
  report(): PluginsReport;
  /** A UI edit of plugins.yaml (or a rescan); applied like a file edit before it resolves. */
  edit(e: PluginsEdit): Promise<PluginsEditOutcome>;
  /** GET /api/machines/config: the machine source, the attached machines, the detected ssh targets. */
  machinesConfig(): MachinesConfig;
  /** A UI edit of plugins.yaml `attachedMachines:`; applied (live) before it resolves. */
  editMachines(e: MachineEdit): Promise<MachineEditOutcome>;
  /** GET /api/routing: plugins.yaml `routing:` and what a rule may name. */
  routing(): RoutingReport;
  /** POST /ui/api/routing: the whole ordered list; applied before it resolves. */
  editRouting(e: RoutingEdit): Promise<RoutingEditOutcome>;
}

/** What intake reads to route a source item (design.md "Routing rules (issue #18)"): the rules now, and the machine ids running. */
export interface RoutingView {
  rules(): readonly RoutingRule[];
  machines(): readonly string[];
}

export interface Clock {
  now(): Date;
}

// ---- Questions -----------------------------------------------------------------------

/** Everything the answerer is given, and (with the draft) the assessor. */
export interface AnswerRequest {
  question: Question;
  /** The job's full prompt. */
  jobPrompt: string;
  jobGoal?: string;
  /** the owner's standing rules, read from the rules file at ask time. */
  rules: string;
  /** The question's trail so far (attempts of earlier runs), so a stage sees what was tried. */
  previous: QuestionAttempt[];
}

/** The answerer's draft: the text to type into the job, whether the rules and context settle it, why. */
export interface AnswerDraft {
  answer: string;
  confident: boolean;
  reason: string;
}

/**
 * The answerer role: drafts an answer. Never throws by contract; the question service still
 * treats a throw, a timeout or a malformed draft as an error, which sends the question to the human.
 */
export interface Answerer {
  /** The instance name (plugins.yaml), which is also the question's stage while it drafts. */
  readonly name: string;
  /** The model it runs, for the trail. */
  readonly model?: string;
  answer(req: AnswerRequest, signal: AbortSignal): Promise<AnswerDraft | { error: string }>;
}

/** The assessor's verdict on a draft: must the owner see this question? */
export interface Assessment {
  escalate: boolean;
  reason: string;
}

/**
 * The assessor role: decides whether a question escalates to the human; it never answers. The
 * question service fails closed on its result: only a schema-valid `escalate: false` accepts;
 * an error, a throw, a timeout or anything malformed escalates.
 */
export interface Assessor {
  /** The instance name (plugins.yaml), which is also the question's stage while it assesses. */
  readonly name: string;
  readonly model?: string;
  assess(req: AnswerRequest, draft: AnswerDraft, signal: AbortSignal): Promise<Assessment | { error: string }>;
}

export type IdGen = () => string;

export interface ExecutorRegistry {
  /** A runnable executor by instance name; undefined for an unknown or unavailable one. */
  get(name: string): Executor | undefined;
  /** The runnable executors' names. */
  names(): string[];
  /** Configured executors that cannot run, and why: their jobs are accepted and held, never failed. */
  unavailable(): ExecutorUnavailable[];
}

/** A usage source whose readings can be set by hand — the fake; set through the engine (tests). */
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
 * Runs the question pipeline: answer → assess → risk rules → accepted or human. Every write is
 * one store.tx and compare-and-set: it applies only if the question is still `open` and (for a
 * stage result) its `tier` is the stage that produced it. `onAnswered` / `onExpired`
 * (constructor options) are synchronous and called INSIDE that same tx, so question and job
 * change together or not at all.
 */
export interface QuestionService {
  /** The stage a new question starts at: the configured answerer's instance name, or `human`. */
  firstStage(): string;
  /** Start the pipeline for a newly asked question (created at `firstStage()`). */
  handle(questionId: string): void;
  answerByHuman(questionId: string, answer: string): AnswerByHumanResult;
  /** the owner ends an open question without answering: status `closed`, the close text becomes its answer, `question.closed`, then onAnswered resumes the job. */
  closeByHuman(questionId: string): AnswerByHumanResult;
  /**
   * The owner answered in the job's pane, not the UI. Synchronous; call inside the caller's tx.
   * Aborts an in-flight stage, clears timers, marks it answered by `human`, `question.answered
   * { via: "pane" }`. Does NOT call onAnswered: the job already runs again, nothing is typed.
   * Undefined when the question is not open.
   */
  answeredInPane(questionId: string, answer: string): Question | undefined;
  /** Synchronous; call inside the caller's tx. Aborts an in-flight stage, clears timers. */
  cancel(questionId: string): void;
  /** Startup: every open non-human question restarts at the answer stage; re-arm human timers, expire overdue ones. */
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
  /** Where `priority` came from, e.g. "project:Priority=P1", "label:hopper:high", "default". */
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

/** What a source observed about a job it owns. Questions are answered in the UI, never through a source. */
export type SourceSignal = { kind: 'cancel'; jobId: JobId; reason: string };

/**
 * What happened to a job, reported back to its source: the claim and the end. Progress and
 * questions are not reported (a source is not where the owner is asked).
 */
export type SourceReport =
  | { kind: 'claimed'; job: Job }
  | { kind: 'finished'; job: Job }
  | { kind: 'failed'; job: Job }
  | { kind: 'cancelled'; job: Job };

export interface JobSource {
  readonly name: string;
  readonly kind: string;
  /** Facts for SourceStatus.detail. */
  describe(): Record<string, unknown>;
  /**
   * A reason the source must not discover new items right now (e.g. the gh source while a
   * GitHub App is configured, or the app source while none is). While paused the sync loop
   * skips `discover` but still runs `check` and reports for the source's own active jobs;
   * status `disabled` when it has none, with `detail.paused` = the reason. Absent → never paused.
   */
  paused?(): string | undefined;
  /** Eligible open items (allowlisted author, labelled, not already done/failed). */
  discover(): Promise<SourceItem[]>;
  /** Signals for this source's non-terminal jobs: cancellations. */
  check(active: Job[]): Promise<SourceSignal[]>;
  /**
   * Tell the source what happened. Returns the WHOLE new `job.sourceState.source` object
   * (it replaces the old one). Idempotent: a retry after a crash never writes twice (label
   * writes are idempotent). Throws
   * SourceError; `permanent: true` means never retry (404/410/403 on the item, oversized
   * body), `false` means retry on a later sync.
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
  /** `tier`: the stage it starts at (the answerer's instance name, or `human`). */
  create(input: { jobId: JobId; text: string; recentOutput: string; detectedBy: string; tier: string }): Question;
  get(id: string): Question | undefined;
  /** Newest first. */
  list(filter?: { status?: QuestionStatus[]; jobId?: JobId; limit?: number }): Question[];
  /** Shallow-merge; `undefined` clears. Bumps updatedAt. */
  update(id: string, patch: Partial<Omit<Question, 'id' | 'jobId' | 'createdAt' | 'attempts'>>): Question;
  /** Append one attempt to the question's trail. */
  addAttempt(id: string, attempt: QuestionAttempt): Question;
}

export interface SettingsRepository {
  getRouterMode(): RouterMode | undefined;
  setRouterMode(mode: RouterMode): void;
}

/** The whole store. One SQLite file; repositories share one connection. */
/** UI sessions, keyed by the SHA-256 of the token; the token itself is never stored. */
export interface UiSessionRepository {
  create(tokenHash: string, expiresAt: string): void;
  /** The expiry of the live session with this hash, or undefined. Expired rows (`expires_at <= now`) are deleted first. */
  find(tokenHash: string, now: string): string | undefined;
  drop(tokenHash: string): void;
}

export interface Store {
  jobs: JobRepository;
  lanes: LaneRepository;
  decisions: DecisionRepository;
  events: EventLog;
  webhooks: WebhookRepository;
  questions: QuestionRepository;
  settings: SettingsRepository;
  uiSessions: UiSessionRepository;
  /** Run fn in one transaction. Re-entrant: a nested tx joins the outer one. Throw = rollback. */
  tx<T>(fn: () => T): T;
  close(): void;
}
