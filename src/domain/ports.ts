// Seams. Everything the engine talks to that is not pure domain logic sits behind one of
// these. Adapters live in src/{executors,machines,usage,plugins,store,webhooks}.

import type { GiveBackRegistry } from './give-back.ts'; import type { IntakeAction, IntakeActionResult, IntakeOutcome } from './intake.ts';
import type {
  Advice, DomainEvent, HostKeyOfferOutcome, PreSortReject, ExecutorUnavailable, Job, JobId, MachineDefaultsEdit, MachineEdit, MachineEditOutcome, MachinesConfig, PluginsEdit,
  NotifierAction, NotifierActionOutcome, NotifierActionResult, PluginsEditOutcome, PluginsReport, RouterStatus, RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule, LaneId, MachineSnapshot,
  Question, SourceStatus, AfterAnswerTimed, UsageReading, UsageSourceState, ToolSignInStart, WebhookDelivery, InstallInfo, UpdatePullRequest, UpdateSettings, UpdateStatus, VersionHistory, ContinuedBy, JobLiveness, ReviewKind, ConnectedAccountKey, ConnectedAccountProvider, ConnectedAccountStatus, PluginStoreEdit, PluginStoreEditOutcome, PluginStoreReport, HandoffResolution, ResolutionWrite, ActingPerson, WorkState, Allowed, RunLogins, TaskCount, ItemEdit, ItemText, HasThread, AnswersFromThread, OwnPullRequestChecks, FailedCheck, ChecksRerun,
} from './types.ts';
import type { UserStore } from './store.ts'; import type { NewRepositoryChange } from './new-repositories.ts'; import type { NoteDelivery } from './job-notes.ts'; import type { ExecutorTerminal } from './terminal.ts'; export type { NoteDelivery } from './job-notes.ts';
import type { RunsPasses, SourceItem, SourceRef } from './source-item.ts'; export type { SourceItem, SourceRef } from './source-item.ts';
import type { ExecutionReport } from './escalation-ports.ts'; import type { FollowsPullRequests, PullRequestAct } from './pull-requests.ts'; import type { ReadsCompanions } from './companion-pull-requests.ts'; import type { WakesOnConflict } from './waiting-pull-requests.ts'; import type { OutboxActs, OutboxGiveBack, OutboxGiveBackMore } from './github-outbox.ts';
export type * from './escalation-ports.ts'; export type { AccessRepository, AuthorizationServer, RelationshipTuple, StoredAccessModel, StoredTuple } from './access.ts';
export { authorizationServerRefusal, isRefusal } from './access.ts'; export type { CredentialMinter } from './minting.ts'; export type { TopologyReader } from './topology-discovery.ts';

// ---- Execution -----------------------------------------------------------------------

export interface ExecutionContext {
  job: Job;
  laneId: LaneId;
  /** The machine the lane is on: an executor that runs work outside the process runs it there. */
  machine: MachineSnapshot;
  /**
   * Aborted on cancel, park or daemon shutdown; `signal.reason` is the string `'cancel'`, `'park'`
   * or `'shutdown'`. On cancel an executor stops the work and releases it; on park or shutdown it
   * returns promptly and leaves external work (a herdr pane) as it is: `park` then releases it.
   */
  signal: AbortSignal;
  /**
   * Report progress (issue #794): a progress message, the job's task count, or both. What is left out keeps what the
   * job has. Emits job.progressed.
   */
  progress(message?: string, tasks?: TaskCount): void;
  /**
   * Persist executor-owned state on the job (`job.executorState`) as soon as it exists — e.g.
   * the herdr pane a job runs in — so restart recovery and resume can find it.
   */
  saveState(state: Record<string, unknown>): void;
  /** Report the job's work tree (its cwd on the lane's machine) once resolved: `job.workTree`, shown on its lane. */
  workTree(path: string): void;
  /** A job Push it continued (issue #1472): the job worktree its kept work names, where it reopens when it recorded no state. */
  keptTree?: import('./kept-work.ts').KeptTree;
  /** Report the agent session the job's agent runs in, once its agent is up (`job.agentSession`, issue #501): a parked job resumes it. */
  agentSession?(id: string): void;
  /**
   * The variables the job's own processes run with: its way to the hopper (issues #563, #652) — the hopper's URL, the
   * files `hopper-gh` and its proxy token kept under `<scratch>/credentials` on the job's machine, and git's way to GitHub
   * through the hopper. Never a GitHub token: the hopper acts on GitHub for the job. Asked when the job starts, resumes,
   * or takes a turn, with the job's own scratch dir, and whether its work tree may be made (the jobs dir). `machine`: the
   * machine the job's work is on, when it is not the lane's — a job pod's (issue #1283); absent: the lane's.
   */
  credentials?: (scratch: string, makeWorkTree?: boolean, machine?: MachineSnapshot) => Promise<Readonly<Record<string, string>>>;
  /**
   * The job rules (issue #172): the text a job's prompt carries before its work tree and the protocol —
   * the config record `job-rules` as it is when the job starts, or the default while none is saved.
   * Absent → the default job rules.
   */
  jobRules?: string;
  /** The logins (issue #476): a login the job's work waits on goes here, never into a question. Absent → none taken. */
  logins?: RunLogins;
  /**
   * Asked before each nudge (issue #627): what the job's source and the hopper say of the job now. A throw: it could
   * not tell. Absent → nudge.
   */
  beforeNudge?(): Promise<NudgeCheck>;
  /**
   * The notes a person sent the job (issue #997): whether any wait for its session, and `take` them — the text to type
   * in, the notes then recorded delivered `how` — or undefined with none. An executor takes them only where its session
   * can read text: as it starts, at a turn boundary, with an answer it types in. Absent → none.
   */
  notes?: { waiting(): boolean; take(how: NoteDelivery): string | undefined };
  /**
   * A missed heartbeat of the job's machine (issue #1569): a watch of its work that failed while the link is up, or a PING
   * of its link not answered in time. The engine takes the job's checkpoint at once, at most once a minute. Absent → none.
   */
  missedHeartbeat?(): void;
  /**
   * A turn's token use the agent's own answer gave (issue #2302, part 6: a print-mode Claude turn, which keeps no agent
   * session the checkpoint reads), by its session: kept in the token ledger, added to that session's. Absent → not kept.
   * `budgetLeftUsd` (issue #2848 part 3): what is left of the job's cost budget in US dollars, a print-mode turn's own cap
   * (it has no park); 0: none is left; undefined: no cost cap.
   */
  tokenUse?(session: string, use: import('./token-usage.ts').SessionTokenUse): void; budgetLeftUsd?(): number | undefined;
}

/**
 * The check before a nudge (issue #627): nudge; or end the job done, with why — its pull request is ready for review,
 * or its issue is closed; or no nudge while it waits on a person, with what it waits on.
 */
export type NudgeCheck = { nudge: true } | { done: string } | { waiting: string };


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
  | { kind: 'finished'; result: unknown; partlyDone?: string }
  /**
   * `tail`: the pane or output tail at failure, codes hidden (issue #509): the assessor's evidence. `liveness`: a
   * timeout's (issue #630), what the job showed of its progress then. `linkLost` (issue #752): its machine's link dropped
   * while its work was watched, so that work may live on there; the engine holds the job and reattaches it when the link is back.
   * `noWayToHopper` (issue #2355): its pane on this machine had no way to the hopper before anything of the job ran there;
   * a job that resumes elsewhere goes back to the queue for another machine. `remoteOutOfReach` (issue #2639): its
   * checkpoint's restore could not fetch the base, the remote not answering; it goes back to the queue the same way.
   */
  | { kind: 'failed'; error: string; tail?: string; liveness?: JobLiveness; linkLost?: true; noWayToHopper?: true; remoteOutOfReach?: true }
  /** The job is paused on a question. Its executor state (saveState) must allow resume. */
  | { kind: 'question'; question: ExecutionQuestion }
  /**
   * The job is paused on a document it wrote for a review section — a proposal, a research report (issues #537, #543)
   * — as on a question: its executor state must allow resume.
   */
  | { kind: 'report'; review: ReviewKind; report: ExecutionReport }
  /**
   * The job waits on something it named (issue #483): no question. Its executor state must let `answeredInPane` see it go
   * on by itself, and `resume` tell it that a person ended the wait. `paused` (issue #2848 part 3): its agent stopped at the
   * job's budget, `why` as it said; the job is parked, and its executor state must let `resume` go on in the same session.
   */
  | { kind: 'wait'; wait: import('./wait-on.ts').WaitAsked } | { kind: 'paused'; why: string };

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
export interface Executor extends ExecutorTerminal {
  readonly name: string;
  /**
   * Safe to run again from scratch after a daemon restart? Default true. A non-idempotent job
   * running at a restart is never re-run: it is reattached (below) or cleaned up and failed.
   */
  readonly idempotent?: boolean;
  /**
   * It runs the research and proposal loop (issues #537, #543, #548): its agent is told the review markers and it comes
   * back with a `report`. Only a job on such an executor may be asked for research or a proposal from its question.
   * Absent: it cannot.
   */
  readonly reviews?: true;
  /** Validate a payload at push time; return an error string or null. */
  validate(payload: Record<string, unknown>): string | null;
  run(ctx: ExecutionContext): Promise<ExecutionOutcome>;
  /**
   * The job run's first steps apart (issue #1662, the `job-run` saga): where the job's credentials go on its machine
   * (its scratch dir, and whether its work tree may be made), placed by the saga's `credentials` step before its pane
   * opens. Undefined: the run cannot start (`open` says why). Present exactly when `open` is.
   */
  credentialsAt?(ctx: ExecutionContext): { scratch: string; makeWorkTree: boolean } | undefined;
  /**
   * Opens the job's pane and starts its agent there, its task saved unsent in its executor state, so that `reattach`
   * sends the task and watches the run, on this hopper or on another after a stop. Undefined: opened. An outcome: the
   * run ended before it ran. `again`: a try of it that a stop cut short may have opened a pane, which is closed first.
   * Absent: `run` places the credentials, opens the pane and runs in one call.
   */
  open?(ctx: ExecutionContext, again?: boolean): Promise<ExecutionOutcome | undefined>;
  /**
   * Continue a job that returned `question`, or a parked one re-queued (`ctx.job.parked`, issue #501): deliver
   * `answer` (from `ctx.job.executorState`) and run until the next outcome. Absent → the executor never asks questions.
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
   * executor state that lets `reattach` watch the new turn; null while it still waits. Absent →
   * never. Must not throw (an error is null). The engine polls it on every tick.
   */
  answeredInPane?(job: Job): Promise<PaneAnswer | null>;
  /**
   * A job waiting on its own background command (issue #1037): true while its pane shows background work; false when it
   * shows none, or its pane or agent is gone; null when that cannot be told now. Must not throw. Absent → never asked.
   */
  ownCommandRuns?(job: Job): Promise<boolean | null>;
  /** A job on its own wait (issue #1508): true when its pane is gone, so what ran in it stopped; null when that cannot be told now. Must not throw. */
  paneLost?(job: Job): Promise<boolean | null>;
  /** Type `text` into a waiting job's pane (issue #1037), as a message to its agent; the job stays as it is. False: not delivered. Must not throw. */
  nudgeInPane?(job: Job, text: string): Promise<boolean>;
  /**
   * Park a job (issue #501): end its pane and its agent, and stop its processes, keeping its work tree and
   * its agent session, so a later `resume` reopens that session (`ctx.job.parked` set). Absent → the executor
   * cannot park. Rejects only when it could not reach the job's machine: the sweep stops what runs there later.
   */
  park?(job: Job): Promise<void>;
  /**
   * An executor that cannot park, but whose ended job reopens in the work tree its state names (issue #1472 part 2): a
   * print-mode agent's. Push it continues the job (`ctx.job.continued`), and `resume` starts a fresh turn there, its task
   * first, then the brief. Absent → only an executor that parks reopens an ended job.
   */
  reopensKept?: true;
  /**
   * The lost-machine move (issue #1569): end the agent a job left on a machine it moved off, its pane named by `left` (the
   * job's executor state there), so it does no more work beside the job's new run. Its work tree stays. Idempotent; when
   * the job runs on that machine again, only the old pane closes. Rejects when that machine cannot be reached yet.
   * `left` is what `leftOf` gave as the job moved: present exactly when `endLeft` is.
   */
  endLeft?(job: Job, left: Job['executorState']): Promise<void>;
  /** What of the job's executor state names the pane it leaves on its machine, and no more (no text it sent): kept with its move. */
  leftOf?(job: Job): Job['executorState'];
  /**
   * Take a running job's checkpoint (issue #921): its agent session and its work not pushed, read on its machine.
   * Undefined when the job has none to take (no agent session, no worktree of its own). Rejects when its machine
   * cannot be reached. Absent → the executor takes none.
   */
  checkpoint?(job: Job): Promise<import('./checkpoints.ts').CheckpointCapture | undefined>;
  /**
   * Release whatever a job holds outside the process (close its pane), and reap what it left (issue
   * #401): its processes stopped, its scratch dir removed. Called after every terminal outcome, when a
   * waiting_answer job is cancelled or expires, and by restart recovery for running jobs it fails.
   * Answers what the reap kept, when it ran. Idempotent. Rejects only when it could not reach where
   * the job's work lives (its machine not dialled in or not answering), so that work may still run:
   * the engine defers the cleanup and tries it again until it goes through (issue #371).
   * `keepScratch` (issue #2494): the reap keeps the scratch dir, as a timed-out job's: a retention is set for the status
   * the job ended in on its machine, and the sweep removes it once that is over.
   */
  cleanup?(job: Job, o?: { keepScratch?: boolean }): Promise<Reaped | void>;
  /**
   * The machine as this executor reaches it, for the sweep (issue #410); undefined when it cannot reach
   * that machine. Absent → the sweep reaches no machine through it.
   */
  machineShell?(machine: MachineSnapshot): MachineShell | undefined;
  /**
   * Removes what it started outside any machine for a job that `ended` says ended (issue #1570: a job pod), for the
   * sweep: the jobs it removed something of. Rejects when it cannot tell (its API not reached). Absent → nothing to sweep.
   */
  sweep?(ended: (jobId: string) => boolean): Promise<string[]>;
}

import type { MachineShell, Reaped } from './machine-shell.ts';
export type { MachineShell, Reaped, Survey } from './machine-shell.ts';

// ---- Inputs the decider is made over ---------------------------------------------------

/** A pluggable source of machines. The local laptop is one; a remote host would be another. */
export interface MachineSource {
  list(): Promise<MachineSnapshot[]>;
}

/**
 * A pluggable usage-budget source. Returns zero or more readings per poll. Every Decision polls
 * every usage source: `poll` must answer from what it already has, never wait on a slow read.
 */
/** A usage source; `signIn` (issue #1128, `ToolSignInStart`): it can start its tool's sign-in on its machine. */
export interface UsageSource extends ToolSignInStart {
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
  /** The questions open at the human stage: high-priority jobs' first (issue #535), then oldest first. */
  waitingOnHuman(): Question[];
  /** Where the human answers a question. */
  answerUrl(questionId: string): string;
  /** The high-priority threshold now (issue #535): a job at or above it is high priority. Absent: the default. */
  highPriority?(): number;
  /**
   * Where a person sees the logins (issue #698): the Logins view; marks out-of-band changes (issue #871): the Infra page;
   * and decides a run card (issue #2197): the Access requests view. Absent: not known.
   */
  loginsUrl?(): string; infraUrl?(): string; accessUrl?(): string;
  /** Where a person opens an artifact (issue #673): its stable URL under the user's link base. Absent: not known. */
  artifactUrl?(id: string): string;
  /** What a notification of the question leads with (issue #569): its TL;DR, else the agent's own summary; undefined: a short question, or the TL;DR off. */
  tldr?(q: Question): string | undefined;
  /** Where the hopper is reached from outside now (issues #795, #880): the remote access URL while its tunnel is up. Absent or undefined: not reached. */
  reach?(): string | undefined;
  /**
   * A plan as a notification says it (issue #870 part 4): what it changes, its risk, who approves it, its watchers. Undefined: no such plan.
   * `deliveries`: the user's notifier deliveries (issue #1587), where a notifier keeps each notification until it is delivered. Absent: kept in memory.
   */
  infraPlan?(id: string): import('./infra-watchers.ts').InfraPlanNotice | undefined; deliveries?: import('./notifier-deliveries.ts').NotifierDeliveryRepository;
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

export interface Clock { now(): Date }

// ---- Questions -----------------------------------------------------------------------

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
   * POST /ui/api/webhooks/test (issue #378): one signed test event to the subscription now — the first
   * type it names, `data.test: true` (issue #481), or `webhook.test` for `*` only —
   * one attempt, no delivery stored and nothing appended; undefined for no such subscription.
   */
  test(name: string): Promise<NotifierActionResult | undefined>;
}

export type AnswerByHumanResult = { ok: true; question: Question } | { ok: false; reason: 'not_found' | 'not_open' };

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
  /** The owner answers an open question. Idempotent per question: the owner's same answer again returns the question unchanged; another answer is `not_open`. */
  answerByHuman(questionId: string, answer: string): AnswerByHumanResult;
  /** The owner ends an open question without answering: status `closed`, the close text becomes its answer, `question.closed`, then onAnswered resumes the job. */
  closeByHuman(questionId: string): AnswerByHumanResult;
  /** The owner drops an open question: status `dismissed`, no answer, `question.dismissed`, then onDismissed (the engine cancels a job still waiting on it). */
  dismissByHuman(questionId: string): AnswerByHumanResult;
  /** A person corrects a level's auto-answer (issue #632, src/questions/auto-answer.ts `correctAutoAnswer`), then onCorrected. */
  correct(questionId: string, answer: string, by: string): { ok: true; question: Question } | { ok: false; reason: 'not_found' | 'not_auto' | 'job_ended' };
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
  /**
   * Settle an open question with `answer` given by `by` (issue #548): `human` for a person's switch, a level's name for
   * its own, `fork:<job id>` for a fork's accepted result; `reason` goes on the trail. Then onAnswered resumes the job,
   * or keeps the answer for a parked one. Synchronous; call inside the caller's tx. Undefined when it is not open.
   */
  settleWith(questionId: string, answer: string, by: string, reason: string): Question | undefined;
  /** Synchronous; call inside the caller's tx. Aborts an in-flight stage, clears timers. */
  cancel(questionId: string): void;
  /**
   * A parked job's question (issue #501) is waited on again: at the human stage, its timeout starts again
   * from now and its timers are armed. While its job is parked, a question never expires and is not renotified.
   */
  unparked(questionId: string): void;
  /** Startup: every open non-human question restarts at the answer stage; re-arm human timers, expire overdue ones. */
  recover(): void;
  /** Cancel the open questions whose job ended or is gone (issue #529): nothing waits on their answer. Run on each tick and by `recover`. */
  sweep(): void;
  stop(): Promise<void>;
}

// ---- Job sources (the hopper pulls; nothing pushes) -----------------------------------

/**
 * What a source observed about a job it owns. Questions are answered in the UI, never through a source.
 * `unassigned` (issue #387): a started job's item is no longer assigned to the account it was taken for — the job is flagged,
 * and the user decides whether to stop it; `reassigned`: a flagged job's item is assigned to it again. `finish` (issue #1460):
 * a job on its own wait whose item closed by its own work (the done-check passes) ends finished, `reason` its result.
 */
export type SourceSignal =
  | { kind: 'cancel' | 'finish'; jobId: JobId; reason: string }
  | { kind: 'unassigned' | 'reassigned'; jobId: JobId };

/**
 * What happened to a job, reported back to its source: the claim and the end. Progress and questions
 * are not reported (a source is not where the owner is asked). A re-run is not a report: `JobSource.rerun`.
 */
export type SourceReport =
  | { kind: 'claimed'; job: Job }
  | { kind: 'finished'; job: Job }
  /** `fixing` (issue #1230): the hopper fixes it itself (Own PR checks red, its Continue pending): no failed mark. */
  | { kind: 'failed'; job: Job; fixing?: boolean }
  | { kind: 'cancelled'; job: Job }
  | { kind: 'rejected'; job: Job };

export interface JobSource extends FollowsPullRequests, ReadsCompanions, HasThread, RunsPasses, Partial<AfterAnswerTimed> {
  readonly name: string;
  readonly kind: string;
  /** Facts for SourceStatus.detail. */
  describe(): Record<string, unknown>;
  /**
   * A reason the source must not discover new items right now (e.g. a connected account's source
   * while none is connected, or while no job repository is chosen). While paused the sync loop
   * skips `discover` but still runs `check` and reports for the source's own active jobs;
   * status `disabled` when it has none, with `detail.paused` = the reason. Absent → never paused.
   */
  paused?(): string | undefined;
  /**
   * Eligible open items (labelled, assigned to the user's account, not already done/failed/rejected). `due` (issue #985):
   * a timed sync — the source reads again only what is due and the rest from what it keeps; absent, a person asked for
   * the sync, and the source reads everything again.
   */
  discover(o?: { due?: boolean }): Promise<SourceItem[]>;
  /**
   * A GitHub delivery said `repo` (`owner/name`) changed (issue #1079): the next discover, a timed one too, reads it again.
   * true when it is one of the source's job repositories, as its last discover scanned them. Absent: the source takes none.
   * `adopts` (issue #1352): a job of a source that no longer runs (a removed instance) — whether this source takes its
   * item, as Run again and Retry need. An item belongs to its repository and issue, not to the source that first saw it:
   * true when the job's repository is one of this source's job repositories, as its last discover scanned them.
   */
  repoChanged?(repo: string): boolean; adopts?(job: Job): boolean;
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
   * Take a done job's item back to rework its open pull request (issue #724): the pull request the job follows becomes a
   * draft and stays open on its branch, then the item is taken back as for `rerun`. Answers the item, the pull request,
   * and the job's source state from now on (it no longer follows the pull request). Throws RerunRefused when there is no
   * open pull request to rework, SourceError when the source cannot be reached. Absent: the source cannot rework.
   */
  rework?(job: Job): Promise<{ item: SourceItem; pullRequest: string; state: Record<string, unknown> }>;
  /**
   * The item as it would be with `text` (issue #662): its title, body, prompt and environment rendered from that text, the
   * rest as read. A source that sets `SourceItem.text` has it: a later job of the item runs its snapshot's text this way.
   */
  withText?(item: SourceItem, text: ItemText): SourceItem;
  /** Who edited the item's title or body since `since` (ISO), from its timeline (issue #662). Absent: the source cannot say. */
  editsSince?(item: SourceItem, since: string): Promise<ItemEdit[]>;
  /**
   * Tell the item what a person did about the job's hand-off (issue #551): on GitHub one short comment — what was
   * done, the note and the link, naming no person — and the end label (done by hand `hopper:done`, won't do
   * `hopper:rejected`; Continue and I fixed it took the item back already). On GitHub they are rows of the GitHub outbox
   * (issue #1238), kept the first time and sent after: asked again, it answers where they stand and keeps nothing more.
   * Throws SourceError; the sync loop asks again at each sync. Absent: the source takes no resolution.
   */
  resolved?(job: Job, resolution: HandoffResolution): Promise<ResolutionWrite>;
  /**
   * Why a job that ended done is not complete (its work did not reach the item's completion, e.g. a
   * merged or an open pull request), or undefined when it is (issues #171, #187). Asked before the
   * job is recorded finished: a reason fails the job with it, and so does a throw (it could not
   * tell). Absent: the source does not judge completion.
   */
  notComplete?(job: Job): Promise<string | undefined>;
  /**
   * What the source says of a failed job's item now: open, or closed and why (`completed`, `not_planned`, `duplicate`).
   * Asked by the sync loop before it reports the failure, only when the work-item ledger does not hold the item closed
   * already (issue #1067, part 4): the answer is recorded as ledger input (`work_item.issue_closed`), and the ledger
   * says whether the job's work landed — its pane ended after its own pull request merged, say (issue #350) — and the job
   * is finished instead. Undefined: it cannot say (the item gone). A throw is asked again on a later sync. Absent: every
   * failed job stays failed unless the ledger holds its item closed as complete.
   */
  issueState?(job: Job): Promise<{ state: 'open' | 'closed'; reason?: string } | undefined>;
  /**
   * What a handed-off job's work shows at the source (issues #529, #621): its item, and the pull requests the job opened
   * or pushed to. Undefined: it cannot tell. Throws: asked again later. Absent: a hand-off waits on a person.
   */
  workState?(job: Job): Promise<Omit<WorkState, 'checkedAt'> | undefined>;
  /**
   * Whether a pull request of the job's own is open (issue #630): one it opened, or an older one it pushed to — a timed-out
   * job's liveness. Throws when it cannot tell now. Absent: the source cannot tell.
   */
  pullRequestOpen?(job: Job): Promise<boolean>;
  /**
   * Own PR checks red (issue #1230). `ownPullRequestChecks`: the job's own open pull request, ready but for its checks, and
   * its checks' state; undefined: none; throws when it cannot tell now. `rerunChecks`: run the failed checks `failed` again
   * once, each that is a GitHub Actions job: the names of the checks run again, and why the others were not (`refused`: no
   * Actions job, no permission); a transient error throws. Absent: the source cannot.
   */
  ownPullRequestChecks?(job: Job): Promise<OwnPullRequestChecks | undefined>; rerunChecks?(failed: readonly FailedCheck[]): Promise<ChecksRerun>;
  /**
   * What became of every open item the last discover listed (issue #440): taken, or the one reason it was not.
   * The sync loop adds each taken item's job and puts the list in SourceStatus.detail.intake. Absent: the source does not say.
   */
  intake?(): IntakeOutcome[];
  /**
   * The user's act on items the last discover listed (Assign to me, Release claim; issue #440). Throws SourceError.
   * Its GitHub writes are outbox rows (issue #1238): `flushOutbox` sends the rows due, one batch, coalesced, and answers how
   * many were due and the repositories it wrote to, so the sync loop lists them again. It never throws: a failed row waits
   * its backoff, or is failed. `pullRequestAct`: a person's Merge now or Close PR (part 3), a row sent through
   * `acts.pullRequest`; it answers the act on its way. `giveBackAct`: a person's act that gives an ended job's item back
   * (Run again and Rework, part 4; Retry, Continue, I fixed it, Push it and Tend again, part 5, with what names their run), a
   * row sent through `acts.giveBack`; it answers the give-back on its way. Either answers undefined when the job names no repository.
   * `releaseOutbox`, at the sync loop's stop (issue #1959): the send under way makes no more calls, and the rows it claimed
   * and did not send are due again at once, so the next start sends them without waiting for their claim to end.
   */
  intakeAction?(action: IntakeAction): Promise<IntakeActionResult>; flushOutbox?(acts?: OutboxActs): Promise<{ due: number; wrote: string[] }>; releaseOutbox?(): void; pullRequestAct?(job: Job, act: PullRequestAct, acting: ActingPerson): PullRequestAct | undefined; giveBackAct?(job: Job, act: OutboxGiveBack, acting?: ActingPerson, more?: OutboxGiveBackMore): OutboxGiveBack | undefined;
}

/**
 * What a job asks the hopper's GitHub proxy with (issue #563): its proxy token and the `hopper-gh` script,
 * kept as files in its credentials dir (by path under it, `paths` the variables pointing there), and `vars`
 * — the hopper's URL as the job's machine reaches it, and git's way to GitHub through it (issue #652). Only
 * where its machine keeps files: the token is never in an environment variable.
 */
export interface JobProxyCredentials {
  /** The hopper's URL as the job's machine reaches it (HOPPER_URL): what the reach check asks for before the job starts (issue #695). */
  url: string;
  files: Record<string, string>;
  paths: Record<string, string>;
  vars: Record<string, string>;
}

export class SourceError extends Error {
  readonly permanent: boolean;
  readonly status?: number;
  constructor(message: string, permanent: boolean, status?: number) {
    super(message); this.name = 'SourceError';
    this.permanent = permanent; if (status !== undefined) this.status = status;
  }
}

/**
 * What the sync loop may do to the hopper. Engine-owned: every method is one store.tx with
 * compare-and-set on the job's current status.
 */
export interface SourceHost extends AnswersFromThread, WakesOnConflict {
  store: UserStore;
  /**
   * Create the job for an item (dedupe by key). null when the key already has a job, or, with `seen` (the newest job of the
   * key the caller read, none when undefined), when the key's newest job is another: another hopper made it meanwhile (issue #2820).
   */
  ingest(item: SourceItem, source: SourceRef, seen?: { jobId: JobId | undefined }): Job | null;
  /**
   * When the item's text changed since its snapshot and nothing deals with it yet — no change held on `jobId`'s job for
   * that text, no original kept —, the snapshot's time (issue #662): the sync loop asks the source who edited it since.
   */
  changedSince(item: SourceItem, jobId?: JobId): string | undefined;
  cancel(jobId: JobId, reason: string): void;
  finishWaiting(jobId: JobId, result: string): void; // the `finish` signal (issue #1460); late or ended: nothing
  /**
   * The item offered again for a job not ended (issue #375): its priority, from the item or a routing rule, as
   * now (job.reprioritized) — a started job's too, the live priority (issue #535); and, while it waits and has not
   * started, its spec's executor, model,
   * work tree, default work tree and machine pin as its source and routing rules give them now, a part
   * changed on the job by hand kept (job.respecified). True when anything changed.
   */
  refresh(jobId: JobId, item: SourceItem, source: SourceRef): boolean;
  /** An operator-led job whose work its source found complete (issue #318): finished. false: it is no longer operator-led. */
  finishOperatorLed(jobId: JobId): boolean;
  /**
   * A failed job whose work shipped (issue #350: its item closed as complete, found before its failure was reported;
   * issue #621: a pull request of its merged, found by the failure assessor's work check): finished, with `result`
   * (default: issue closed as complete), and its end to be reported to its source again. false: it is no longer failed.
   */
  finishShipped(jobId: JobId, result?: { summary: string; link?: string; backfill?: string }): boolean;
  /** A failed job whose work its source now finds done or partly done (issue #579): finished. false: it is no longer failed. */
  finishComplete(jobId: JobId, partlyDone?: string): boolean;
  /** Replace sourceState in one tx that re-reads the job. */
  setSourceState(jobId: JobId, state: { sync?: Record<string, unknown>; source?: Record<string, unknown> }): void;
  /**
   * Its source gave this ended job's item back (issues #313, #354): the new job for `item`, created as
   * `ingest` does (routing rules, the queue gate) with `rerunOf` the ended job, and job.rerun on the
   * ended job, in one tx. The ended job stays as it ended. A newer job of the key that already exists
   * is answered instead of a second one. `by`: who asked, the user (the default) or the failure assessor (issue #509).
   * `brief` (issue #551): what the new job is told after its item's prompt — a person's note and the failure before it.
   * `acting` (issue #623): the person who asked from Failures, and the way, kept in job.rerun.
   */
  rerun(jobId: JobId, item: SourceItem, source: SourceRef, by?: RerunBy, brief?: string, acting?: ActingPerson): Job;
  /**
   * Its source gave a failed job's item back for a Continue — a person's on its hand-off (issue #551), or the
   * assessor's on its record (issue #630): the same job is queued again, in one tx, pinned to the machine it ran on
   * with `brief` pending (`continued`), its end to be reported to its source again, so its claim resumes its own agent
   * session. job.continued. Push it (issue #1010, `by` `keptWork`) takes a finished or cancelled job too. Refused
   * (not_found, conflict) when it is gone, no longer failed (or, for Push it, not one of `PUSHABLE_ENDS`), or a newer job
   * of its item exists.
   */
  continueJob(jobId: JobId, brief: string, by: ContinuedBy): RerunResult;
  /**
   * Its source gave a done job's item back for rework (issue #724): the ended job's source state is replaced by `state`
   * (it no longer follows its pull request), and the new job for `item` is created as `rerun` does, told the rework brief,
   * with `rework` set; job.rework_requested on the ended job, in one tx.
   */
  rework(jobId: JobId, item: SourceItem, source: SourceRef, rework: { pullRequest: string; notes: string; state: Record<string, unknown> }, acting?: ActingPerson): Job;
}

/**
 * Discovery is re-run every poll; for items that already have a job not ended the sync loop
 * compares `priority` and re-prioritizes the job (event `job.reprioritized`).
 */
/** The sync loop's view, for /api/sources and SSE `source.updated`. */
export interface SourceRegistry extends GiveBackRegistry, AfterAnswerTimed {
  statuses(): SourceStatus[];
  onStatus(listener: (status: SourceStatus) => void): () => void;
  /**
   * Run an ended job's item again (Run again, issues #313, #354): its source gives the item back
   * (`JobSource.rerun`) and the new job is queued at once; it answers the new job. The ended job is kept.
   * Only a failed or finished job, the newest of its item, once its end was reported to the source.
   */
  rerun(jobId: JobId, by?: RerunBy, brief?: string, acting?: ActingPerson): Promise<RerunResult>;
  /**
   * Continue a failed job in its own agent session (issue #551): its source gives the item back as for Run again, and
   * the same job is queued again with `brief` pending (`SourceHost.continueJob`). Refused as Run again is; Push it's
   * (`keptWork`, issue #1010) takes a cancelled job too.
   */
  continueJob(jobId: JobId, brief: string, by: ContinuedBy): Promise<RerunResult>;
  /**
   * Whether the ended job's source takes its item back now (issue #1010), as Run again, Continue and Push it need: its
   * source runs, can run an item again, and was told the job's end. The views offer those only when it does.
   */
  takesBack(jobId: JobId): Allowed;
  /**
   * The user's act on items a source listed (Assign to me, Release claim; issue #440), answered once the act is recorded;
   * a sync of that source runs after, not awaited (issue #1194), and its status shows the result. not_found: no running source of that name; conflict: it takes no such act.
   */
  intakeAction(source: string, action: IntakeAction): Promise<IntakeActionOutcome>;
  /**
   * A GitHub delivery said `repo` (`owner/name`) changed (issue #1079): each running source whose job repository it is
   * reads it again at a sync soon after. The names of those sources; none when no source takes it.
   */
  repoChanged(repo: string): string[];
  /**
   * A person's Merge now or Close PR on a finished job's open pull request (issue #677), answered at once (issue #1194):
   * refused (not_found, conflict) when the job is gone, its source is not running or follows no pull request, or the job
   * has no open pull request. After the answer, on the job's report chain, its source merges it — whatever yolo mode and
   * its checks say — or closes it without a merge, and it is recorded as a follow-up is, with who pressed it; one GitHub
   * refuses, or that cannot reach GitHub, records `job.pull_request_act_failed` with why. The same job's act sent again
   * while one runs answers that one.
   */
  pullRequestAct(jobId: JobId, act: PullRequestAct, acting: ActingPerson): PullRequestActAnswer;
  /**
   * A person's Tend again (issue #1010) on a pull request the hopper gave up on (its tend job ended failed, cancelled or
   * rejected): the same step is tended at once, recorded with who pressed it. Refused (not_found, conflict) with why.
   */
  tendAgain(jobId: JobId, acting: ActingPerson): Promise<RerunResult>;
}

/** Merge now or Close PR answered (issue #1194): it runs after the answer, or why it is refused now. */
export type PullRequestActAnswer =
  | { ok: true; jobId: string; act: PullRequestAct }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string };

export type IntakeActionOutcome =
  | { ok: true; result: IntakeActionResult }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string };

/** Who asks for an ended job's item to run again: the user, the failure assessor (issue #509), tending (issue #736), or the item reconciler (issue #1891). */
export type RerunBy = 'user' | 'assessor' | 'tending' | 'reconciler';

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

/** What the hopper sees of the stack it runs in (issue #697, "The stack against its compose file"): from inside its container, never the container runtime's. */
export interface StackProbe {
  /** Whether `service` has a name on the compose network: compose names each running service's container by it. */
  resolves(service: string): Promise<boolean>;
  /** The commit the vault in its own container says it runs; null when it is not reached or does not say. */
  vaultCommit(): Promise<string | null>;
}

/** Whether a commit may be updated to (issue #652): the merge of a pull request whose checks passed, or why not. */
export type ReleaseVerdict = { passed: true; pullRequest: UpdatePullRequest } | { passed: false; reason: string };

/** The release check: asks where the update repository lives whether `commit` is a merged pull request with passing checks. */
export interface ReleaseCheck {
  verify(repo: string, commit: string): Promise<ReleaseVerdict>;
}

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
  refreshToken?: string; refreshTokenExpiresAt?: string;
  /** How GitHub granted it (issue #441): the browser's web flow or the device flow. */
  grantedBy?: 'device' | 'web';
}

/** A user's connected accounts (issue #214): GET /api/connected-accounts, POST /ui/api/connected-accounts. */
export interface ConnectedAccounts {
  /**
   * Each takes the account's key (issue #1448): the first account's is its provider. `status`: every account's, the first at
   * each provider in CONNECTED_ACCOUNT_PROVIDERS order, then the further ones; GitHub's with where the app is installed, as last read
   * (issue #1250): never reads GitHub. `refresh`: reads where the app is installed from GitHub again, in the background;
   * answers at once, `installationsReading` while it reads.
   */
  status(): Promise<ConnectedAccountStatus[]>; refresh(key: ConnectedAccountKey): ConnectedAccountStatus;
  /**
   * Keep the connection a GitHub sign-in made: it replaces the account there was, unless that one is healthy — then it is
   * held until the person takes or drops it (issue #647).
   */
  adopt(connection: Connection): Promise<void>;
  /**
   * Start the provider's device flow and answer once it shows the device code; a waiting one answers its own code. `email`:
   * the email the person signed in with (issue #1380): with the source email match on, the account must have it verified.
   */
  connect(key: ConnectedAccountKey, by?: { email?: string }): Promise<ConnectedAccountStatus>;
  /**
   * Connect with a personal access token the person gives (issue #1380): no GitHub App. GitHub must take it; the source email
   * match applies as for `connect`. Kept as the connection's access token, in the user's vault; never renewed, never deleted at
   * GitHub. Answers the status: connected, or failed with why.
   */
  connectToken(key: ConnectedAccountKey, token: string, by?: { email?: string }): Promise<ConnectedAccountStatus>;
  /** Replace the connection with the held grant of a sign-in (issue #647); running jobs are handed its token. `cancel`: end a waiting device code. */
  takeHeld(key: ConnectedAccountKey): Promise<ConnectedAccountStatus>; cancel(key: ConnectedAccountKey): ConnectedAccountStatus;
  /** Drop the held grant of a sign-in (issue #647), its token deleted at GitHub (best effort); the connection stays. */
  dropHeld(key: ConnectedAccountKey): Promise<ConnectedAccountStatus>;
  /** Whether the account's sign-in ended (issue #513): GitHub refused it, or it expired with nothing to renew it. Not while it cannot be read. */
  expired(key: ConnectedAccountKey): boolean;
  /** Revoke the account's grant at GitHub (best effort; issue #514), then forget the account and its token; its job repositories stay chosen. */
  disconnect(key: ConnectedAccountKey): Promise<ConnectedAccountStatus>;
  /**
   * Choose the repositories the account's jobs may use (issue #321), the whole list; the source syncs now. A repository is a
   * job repository of one account only (issue #1448): one chosen for another account already is refused.
   */
  /**
   * `newRepositories`: change the account's new-repository policy, the whole of it, or dismiss its asks (issue #2795); a new
   * policy applies at once to what the last read reached.
   */
  choose(key: ConnectedAccountKey, repositories: readonly string[]): Promise<ConnectedAccountStatus>; newRepositories(key: ConnectedAccountKey, change: NewRepositoryChange): Promise<ConnectedAccountStatus>;
  /**
   * `add`: a further account at `provider` with a personal access token (issue #1448): GitHub must take it, the source email
   * match applies, and its login must not be one connected already. With no first account, the token connects the first.
   * Answers its status: connected under its new key, or failed with why, and then nothing is kept. `keys`: every account's
   * key, the first at each provider, then the further ones kept, in order.
   */
  add(provider: ConnectedAccountProvider, token: string, by?: { email?: string }): Promise<ConnectedAccountStatus>; keys(): ConnectedAccountKey[];
}

/** What a connected account's job source asks (issue #214): who the account is, a token for a call, where its provider is. */
export interface ConnectedAccountTokens {
  /** The connected account's login, or undefined while none is connected or its sign-in expired. */
  account(key: ConnectedAccountKey): string | undefined;
  /** What to do now that the account's sign-in expired (issue #358), or its tokens cannot be opened (issue #514); undefined while it lives, or none is connected. */
  ended(key: ConnectedAccountKey): string | undefined;
  /** Whether the account's sign-in ended (issues #513, #514): GitHub refused it, or it expired with nothing to renew it. Not while it cannot be read. */
  expired(key: ConnectedAccountKey): boolean;
  /** Its access token now, renewed first when it is near its expiry (issue #358); throws while none is connected, or once its sign-in expired. */
  token(key: ConnectedAccountKey): Promise<string>;
  /** A token GitHub refused (a 401): renewed, unless it was already; throws once the sign-in expired. */
  renew(key: ConnectedAccountKey, refused: string): Promise<string>;
  /** The provider's web origin and REST API base, and the hopper's app's install link when its slug is known (issue #1351). */
  endpoints(key: ConnectedAccountKey): { url: string; apiUrl: string; installUrl?: string };
  /** The repositories the account's jobs may use, as chosen now (issue #321); empty: none. */
  jobRepositories(key: ConnectedAccountKey): string[];
}

// ---- Sandbox boxes the hopper launches: src/domain/sandboxes.ts (re-exported here, one vocabulary) ----

export type * from './sandboxes.ts';

// ---- Windows sandbox steps (issue #731): the host a step runs on, src/domain/windows-steps.ts ----

export type { WindowsStepHost } from './windows-steps.ts';

// ---- Search (issue #945): the search index, src/domain/search.ts ----

export type { SearchIndex } from './search.ts';

// ---- Persistence: src/domain/store.ts (re-exported here, one vocabulary) ----------------

export type * from './store.ts'; export type * from './local-accounts.ts'; export type * from './event-cursors.ts'; export type * from './lane-pool-keys.ts'; // local accounts (issue #1380), event cursors (issue #1572), lane pool keys the hopper issues (issue #1454)
export { CONFIG_NAMES, INSTANCE_CONFIG, USER_CONFIG } from './store.ts';
