// Seams. Everything the engine talks to that is not pure domain logic sits behind one of
// these. Adapters live in src/{executors,machines,usage,plugins,store,webhooks}.

import type {
  Advice, DomainEvent, HostKeyOfferOutcome, PreSortReject, ExecutorUnavailable, Job, JobId, MachineDefaultsEdit, MachineEdit, MachineEditOutcome, MachinesConfig, PluginsEdit,
  NotifierAction, NotifierActionOutcome, NotifierActionResult, PluginsEditOutcome, PluginsReport, RouterStatus, RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule, LaneId, MachineSnapshot,
  Question, QuestionAttempt, SourceStatus, UsageReading, UsageSourceState, WebhookDelivery, InstallInfo, UpdateSettings, UpdateStatus, VersionHistory,
  ConnectedAccountProvider, ConnectedAccountStatus, PluginStoreEdit, PluginStoreEditOutcome, PluginStoreReport,
} from './types.ts';
import type { UserStore } from './store.ts';

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
  /** Report the job's work tree (its cwd on the lane's machine) once resolved: `job.workTree`, shown on its lane. */
  workTree(path: string): void;
  /**
   * Variables the job's own processes run with, from its source's connection (issue #214): GH_TOKEN of
   * the GitHub account the job came from, so what the job does on GitHub acts as that user with the
   * hopper's app marked on it. Asked when the job starts or resumes; never stored on the job.
   */
  credentials?: Readonly<Record<string, string>>;
  /**
   * The job rules (issue #172): the text a job's prompt carries before its work tree and the protocol —
   * the config record `job-rules` as it is when the job starts, or the default while none is saved.
   * Absent → the default job rules.
   */
  jobRules?: string;
}

/** What the executor needs answered before the job can continue. */
export interface ExecutionQuestion {
  /** The question as the agent asked it. */
  text: string;
  /** Recent output of the job (pane tail), for whoever answers. */
  recentOutput: string;
  /** How it was detected: "marker" | "blocked" | "idle". */
  detectedBy: string;
  /** A dialog with a countdown (issue #376): when the agent denies it by itself, unless answered first. */
  lapsesAt?: string;
}

export type ExecutionOutcome =
  | { kind: 'finished'; result: unknown }
  | { kind: 'failed'; error: string }
  /** The job is paused on a question. Its executor state (saveState) must allow resume. */
  | { kind: 'question'; question: ExecutionQuestion };

/**
 * What `Executor.answeredInPane` saw: the typed answer (if readable) and the state to reattach with.
 * `lapsed`: nobody answered; the agent denied its dialog by itself when the countdown ran out (issue #376).
 */
export interface PaneAnswer { answer?: string; lapsed?: true; executorState: Record<string, unknown> }

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
   * outside the process (its pane and agent), so `reattach` can watch it? Absent → never. Rejects
   * when that cannot be told now — its machine does not answer yet (a client target not dialled
   * in, an ssh target not replying): recovery asks again until the reconnect grace runs out.
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
   * Release whatever a job holds outside the process (close its pane), and reap what it left (issue
   * #401): its processes stopped, its scratch dir removed. Called after every terminal outcome, when a
   * waiting_answer job is cancelled or expires, and by restart recovery for running jobs it fails.
   * Answers what the reap kept, when it ran. Idempotent. Rejects only when it could not reach where
   * the job's work lives (its machine not dialled in or not answering), so that work may still run:
   * the engine defers the cleanup and tries it again until it goes through (issue #371).
   */
  cleanup?(job: Job): Promise<Reaped | void>;
  /**
   * The machine as this executor reaches it, for the sweep (issue #410); undefined when it cannot reach
   * that machine. Absent → the sweep reaches no machine through it.
   */
  machineShell?(machine: MachineSnapshot): MachineShell | undefined;
}

/** What the reap at a job's end kept: repositories in its scratch dir holding uncommitted or unpushed work. */
export interface Reaped { kept: string[] }

/** What a job left on a machine, as the sweep's survey finds it (issue #410): job ids, and each scratch dir with its age. */
export interface Survey {
  /** Jobs with a running scope (`hopper-job-<id>.scope`). */
  scopes: string[];
  /** Jobs with a process carrying their HOPPER_JOB_ID. */
  processes: string[];
  /** Each `<work tree>/.hopper-scratch/<job id>` under the work trees asked about. */
  scratch: { jobId: string; path: string; ageMs: number }[];
}

/**
 * A machine as the reap and the sweep reach it (issue #410): the fixed scripts run there through its own
 * connection — this machine, ssh, or a client target's `/reap` and `/survey` — never in a pane. Each
 * rejects when the machine cannot be reached or the script did not finish.
 */
export interface MachineShell {
  /** Stops the job's scope and every process carrying its id; removes `scratch` (its own) unless it holds work not pushed. */
  reap(jobId: string, scratch?: string): Promise<Reaped>;
  /** What jobs left there: scopes, processes, and the scratch dirs under `roots`. */
  survey(roots: string[]): Promise<Survey>;
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

/**
 * What a notifier is given at start: the event log's live feed, the job and question an event names,
 * and the questions open at the human now with where each is answered (issue #378).
 */
export interface NotifierEvents {
  /** Called after each append (listeners must not re-enter synchronously: defer the work). Returns the unsubscribe. */
  subscribe(listener: (event: DomainEvent) => void): () => void;
  job(id: JobId): Job | undefined;
  question(id: string): Question | undefined;
  /** The questions open at the human stage, oldest first. */
  waitingOnHuman(): Question[];
  /** Where the human answers a question. */
  answerUrl(questionId: string): string;
}

/**
 * The notifier role: tells something outside about events. Started once, stopped at shutdown.
 * `test` and `sendOpen` (issue #378) are optional: what the UI's notifier actions call.
 */
export interface Notifier {
  readonly name: string;
  start(events: NotifierEvents): void;
  /** Unsubscribes and settles in-flight work. */
  stop(): Promise<void>;
  /** Send one marked test payload now, one attempt; the receiver's answer. */
  test?(): Promise<NotifierActionResult>;
  /** Send every question open at the human now, once each per call. */
  sendOpen?(): Promise<NotifierActionResult>;
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
 *
 * `reject` (optional, issue #159): the jobs not yet accepted at the queue gate that this sorter
 * turns away, each with a reason — the pre-sort's rejections. Throwing or returning anything but
 * `{ jobId, reason }` of the given jobs rejects nothing for that call.
 */
export interface QueueSorter {
  readonly name: string;
  sort(entries: readonly QueueEntry[]): JobId[];
  reject?(entries: readonly QueueEntry[]): PreSortReject[];
}

/** What the HTTP edge reads about plugins: the router's status and GET /api/plugins. */
export interface PluginsView {
  routerStatus(): RouterStatus;
  report(): PluginsReport;
  /** A UI edit of the plugins config (or a rescan); applied like a file edit before it resolves. */
  edit(e: PluginsEdit): Promise<PluginsEditOutcome>;
  /** GET /api/machines/config: every machine-source instance, the executors, the detected ssh targets. */
  machinesConfig(): Promise<MachinesConfig>;
  /** Attach an ssh target as an `ssh` instance in the plugins config `machines:`; applied (live) before it resolves. */
  editMachines(e: MachineEdit): Promise<MachineEditOutcome>;
  /** POST /ui/api/machines/host-key (issue #293): the host key a new ssh target would be pinned to, for the person to confirm; nothing written. */
  machineHostKey(ssh: string): Promise<HostKeyOfferOutcome>;
  /** POST /ui/api/machines/defaults (issue #142): the plugins config `machineDefaults:`. */
  editMachineDefaults(e: MachineDefaultsEdit): Promise<MachineEditOutcome>;
  /** GET /api/routing: the plugins config `routing:` and what a rule may name. */
  routing(): RoutingReport;
  /** POST /ui/api/routing: the whole ordered list; applied before it resolves. */
  editRouting(e: RoutingEdit): Promise<RoutingEditOutcome>;
  /** POST /ui/api/notifiers (issue #378): a running notifier's action, by instance name. */
  notifierAction(name: string, action: NotifierAction): Promise<NotifierActionOutcome>;
}

/** The plugin store (design.md "Plugin store"): GET /api/plugin-store, POST /ui/api/plugin-store. */
export interface PluginStoreView {
  report(): PluginStoreReport;
  /** Refresh, install (or update) or remove one store install; the new report. */
  edit(e: PluginStoreEdit): Promise<PluginStoreEditOutcome>;
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
  /**
   * POST /ui/api/webhooks/test (issue #378): one signed `webhook.test` event to the subscription now,
   * one attempt, no delivery stored and nothing appended; undefined for no such subscription.
   */
  test(name: string): Promise<NotifierActionResult | undefined>;
}

export type AnswerByHumanResult =
  | { ok: true; question: Question }
  | { ok: false; reason: 'not_found' | 'not_open' };

/**
 * Runs the question pipeline: answer → assess → risk rules → accepted or human. Every write is
 * one store.tx and compare-and-set: it applies only if the question is still `open` and (for a
 * stage result) its `tier` is the stage that produced it. `onAnswered` / `onExpired` / `onDismissed`
 * (constructor options) are synchronous and called INSIDE that same tx, so question and job
 * change together or not at all.
 */
export interface QuestionService {
  /** The stage a new question starts at: the first escalation level's instance name, or `human` with none. */
  firstStage(): string;
  /** Start the pipeline for a newly asked question (created at `firstStage()`). */
  handle(questionId: string): void;
  answerByHuman(questionId: string, answer: string): AnswerByHumanResult;
  /** The owner ends an open question without answering: status `closed`, the close text becomes its answer, `question.closed`, then onAnswered resumes the job. */
  closeByHuman(questionId: string): AnswerByHumanResult;
  /** The owner drops an open question: status `dismissed`, no answer, `question.dismissed`, then onDismissed (the engine cancels a job still waiting on it). */
  dismissByHuman(questionId: string): AnswerByHumanResult;
  /** The owner saw the question in the UI: `seenAt` is set once and kept. Any status. */
  markSeen(questionId: string): { ok: true; question: Question } | { ok: false; reason: 'not_found' };
  /**
   * The owner answered in the job's pane, not the UI. Synchronous; call inside the caller's tx.
   * Aborts an in-flight stage, clears timers, marks it answered by `human`, `question.answered
   * { via: "pane" }`. Does NOT call onAnswered: the job already runs again, nothing is typed.
   * Undefined when the question is not open.
   */
  answeredInPane(questionId: string, answer: string): Question | undefined;
  /**
   * Nobody answered: the agent denied the question's dialog by itself when its countdown ran out (issue
   * #376). Synchronous; call inside the caller's tx. Aborts an in-flight stage, clears timers, status
   * `lapsed`, `question.lapsed`; no answer, nobody answered it, no onAnswered. Undefined when the question
   * is not open or has no countdown.
   */
  lapsedInPane(questionId: string): Question | undefined;
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
  /** The login the item was taken for (issue #387: an issue assigned to the user's connected account). */
  assignee?: string;
  priority: number;
  /** Where `priority` came from, e.g. "project:Priority=P1", "label:hopper:high", "default". */
  priorityReason: string;
  /** The job's own work tree: its repository's path (`repoPaths`). Absent: the machine's, then `defaultCwd` (issue #324). */
  cwd?: string;
  /** The source's default work tree: the job's when neither it nor its machine names one (issue #324). Absent: the executor's. */
  defaultCwd?: string;
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

/**
 * What a source observed about a job it owns. Questions are answered in the UI, never through a source.
 * `unassigned` (issue #387): a started job's item is no longer assigned to the account it was taken for —
 * the job is flagged, and the user decides whether to stop it; `reassigned`: a flagged job's item is
 * assigned to it again.
 */
export type SourceSignal =
  | { kind: 'cancel'; jobId: JobId; reason: string }
  | { kind: 'unassigned'; jobId: JobId }
  | { kind: 'reassigned'; jobId: JobId };

/**
 * What happened to a job, reported back to its source: the claim and the end. Progress and questions
 * are not reported (a source is not where the owner is asked). A re-run is not a report: `JobSource.rerun`.
 */
export type SourceReport =
  | { kind: 'claimed'; job: Job }
  | { kind: 'finished'; job: Job }
  | { kind: 'failed'; job: Job }
  | { kind: 'cancelled'; job: Job }
  | { kind: 'rejected'; job: Job };

export interface JobSource {
  readonly name: string;
  readonly kind: string;
  /** Facts for SourceStatus.detail. */
  describe(): Record<string, unknown>;
  /**
   * A reason the source must not discover new items right now (e.g. a connected account's source
   * while none is connected, or the app source while no app is configured). While paused the sync loop
   * skips `discover` but still runs `check` and reports for the source's own active jobs;
   * status `disabled` when it has none, with `detail.paused` = the reason. Absent → never paused.
   */
  paused?(): string | undefined;
  /** Eligible open items (labelled, assigned to the user's account, not already done/failed/rejected). */
  discover(): Promise<SourceItem[]>;
  /** Signals for this source's non-terminal jobs: cancellations and assignment drift. */
  check(active: Job[]): Promise<SourceSignal[]>;
  /**
   * Tell the source what happened. Returns the WHOLE new `job.sourceState.source` object
   * (it replaces the old one). Idempotent: a retry after a crash never writes twice (label
   * writes are idempotent). Throws SourceError; `permanent: true` means never retry (404/410/403 on the item, oversized
   * body), `false` means retry on a later sync.
   */
  report(report: SourceReport): Promise<Record<string, unknown>>;
  /**
   * Take an ended job's item back to run again (Run again, issues #313, #354): clear the job's end at
   * the source so the new job can run and finish against the item — on GitHub, reopen a closed issue,
   * drop the end labels, put the source label back — and answer the item as it stands now, for the new
   * job. Throws SourceError. Absent: the source cannot run an item again on request.
   */
  rerun?(job: Job): Promise<SourceItem>;
  /**
   * Why a job that ended done is not complete (its work did not reach the item's completion, e.g. a
   * merged or an open pull request), or undefined when it is (issues #171, #187). Asked before the
   * job is recorded finished: a reason fails the job with it, and so does a throw (it could not
   * tell). Absent: the source does not judge completion.
   */
  notComplete?(job: Job): Promise<string | undefined>;
  /**
   * Whether a failed job's item is closed as complete: its work landed though the job ended failed —
   * its pane ended after its own pull request merged, say (issue #350). Asked by the sync loop before it
   * reports the failure: true finishes the job instead. A throw is asked again on a later sync. Absent:
   * every failed job stays failed.
   */
  closedAsComplete?(job: Job): Promise<boolean>;
  /** The variables the job's processes run with to act through the source's connection (ExecutionContext.credentials); absent: none. */
  credentials?(job: Job): Promise<Record<string, string>>;
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
  store: UserStore;
  /** Create the job for an item (dedupe by key). null when the key already has a job. */
  ingest(item: SourceItem, source: { name: string; kind: string }): Job | null;
  cancel(jobId: JobId, reason: string): void;
  /**
   * The item offered again for a waiting (queued/held) job (issue #375): its priority, from the item or a
   * routing rule, as now (job.reprioritized); and, while it has not started, its spec's executor, model,
   * work tree, default work tree and machine pin as its source and routing rules give them now, a part
   * changed on the job by hand kept (job.respecified). True when anything changed.
   */
  refresh(jobId: JobId, item: SourceItem, source: { name: string; kind: string }): boolean;
  /** An operator-led job whose work its source found complete (issue #318): finished. false: it is no longer operator-led. */
  finishOperatorLed(jobId: JobId): boolean;
  /** A failed job whose item its source found closed as complete (issue #350): finished. false: it is no longer failed. */
  finishClosedAsComplete(jobId: JobId): boolean;
  /** Replace sourceState in one tx that re-reads the job. */
  setSourceState(jobId: JobId, state: { sync?: Record<string, unknown>; source?: Record<string, unknown> }): void;
  /**
   * Its source gave this ended job's item back (issues #313, #354): the new job for `item`, created as
   * `ingest` does (routing rules, the queue gate) with `rerunOf` the ended job, and job.rerun on the
   * ended job, in one tx. The ended job stays as it ended. A newer job of the key that already exists
   * is answered instead of a second one.
   */
  rerun(jobId: JobId, item: SourceItem, source: { name: string; kind: string }): Job;
}

/**
 * Discovery is re-run every poll; for items that already have a waiting job the sync loop
 * compares `priority` and re-prioritizes the job (event `job.reprioritized`).
 */
/** The sync loop's view, for /api/sources and SSE `source.updated`. */
export interface SourceRegistry {
  statuses(): SourceStatus[];
  onStatus(listener: (status: SourceStatus) => void): () => void;
  /**
   * Run an ended job's item again (Run again, issues #313, #354): its source gives the item back
   * (`JobSource.rerun`) and the new job is queued at once; it answers the new job. The ended job is kept.
   * Only a failed or finished job, the newest of its item, once its end was reported to the source.
   */
  rerun(jobId: JobId): Promise<RerunResult>;
}

export type RerunResult =
  | { ok: true; job: Job }
  | { ok: false; reason: 'not_found' | 'conflict' | 'source'; message: string };

// ---- Self-update (issue #44) ------------------------------------------------------------

/** Builds an install of the source tree `sourceDir` into `targetDir` (scripts/install.sh build-only mode in production). */
export interface UpdateBuilder {
  build(sourceDir: string, targetDir: string, info: InstallInfo): Promise<void>;
}

/** Ends this process so it starts again on the install now in place (exit for the supervisor, or respawn). Never returns in production. */
export type Restarter = () => Promise<void>;

/** The daemon's self-update: GET /api/update, POST /ui/api/update. */
export interface Updater {
  status(): UpdateStatus;
  /** Fetch the repository and compare; answers the new status. */
  check(): Promise<UpdateStatus>;
  /** Start applying the target; answers at once with `apply` set. Refuses (`error`) when nothing is available or an apply runs. */
  apply(): { ok: true; status: UpdateStatus } | { ok: false; error: string };
  settings(patch: Partial<UpdateSettings>): UpdateStatus;
  /** The version history of the installed commit; checks first when the update repository lacks it. */
  history(): Promise<VersionHistory>;
}

/** A token GitHub granted the hopper's app, with who it belongs to (issue #214): a GitHub sign-in hands it to the session's user. */
export interface Connection {
  provider: ConnectedAccountProvider;
  subject: string;
  account: string;
  accessToken: string;
  /** ISO time; absent: the token does not expire. */
  expiresAt?: string;
  /** What renews the token, and when it expires itself (issue #358); absent: nothing renews it. */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

/** A user's connected accounts (issue #214): GET /api/connected-accounts, POST /ui/api/connected-accounts. */
export interface ConnectedAccounts {
  /** Every provider's, in CONNECTED_ACCOUNT_PROVIDERS order; GitHub's with where the app is installed. */
  status(): Promise<ConnectedAccountStatus[]>;
  /** Keep the connection a GitHub sign-in made (it replaces the account there was). */
  adopt(connection: Connection): void;
  /** Start the provider's device flow and answer once it shows the device code; a waiting one answers its own code. */
  connect(provider: ConnectedAccountProvider): Promise<ConnectedAccountStatus>;
  /** End a waiting device code. */
  cancel(provider: ConnectedAccountProvider): ConnectedAccountStatus;
  /** Forget the account and its token; its job repositories stay chosen. */
  disconnect(provider: ConnectedAccountProvider): ConnectedAccountStatus;
  /** Choose the repositories the account's jobs may use (issue #321), the whole list; the source syncs now. */
  choose(provider: ConnectedAccountProvider, repositories: readonly string[]): Promise<ConnectedAccountStatus>;
}

/** What a connected account's job source asks (issue #214): who the account is, a token for a call, where its provider is. */
export interface ConnectedAccountTokens {
  /** The connected account's login, or undefined while none is connected or its sign-in expired. */
  account(provider: ConnectedAccountProvider): string | undefined;
  /** What to do now that the account's sign-in expired (issue #358); undefined while it has not, or none is connected. */
  ended(provider: ConnectedAccountProvider): string | undefined;
  /** Its access token now, renewed first when it is near its expiry (issue #358); throws while none is connected, or once its sign-in expired. */
  token(provider: ConnectedAccountProvider): Promise<string>;
  /** A token GitHub refused (a 401): renewed, unless it was already; throws once the sign-in expired. */
  renew(provider: ConnectedAccountProvider, refused: string): Promise<string>;
  /** The provider's web origin and REST API base. */
  endpoints(provider: ConnectedAccountProvider): { url: string; apiUrl: string };
  /** The repositories the account's jobs may use, as chosen now (issue #321); empty: none. */
  jobRepositories(provider: ConnectedAccountProvider): string[];
}

// ---- Persistence: src/domain/store.ts (re-exported here, one vocabulary) ----------------

export type * from './store.ts';
export { CONFIG_NAMES, INSTANCE_CONFIG, USER_CONFIG } from './store.ts';
