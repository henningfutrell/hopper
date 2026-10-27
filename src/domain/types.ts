// The hopper domain vocabulary. Every name here is defined in docs/glossary.md;
// change the glossary in the same commit as any rename.
import type { CleanupDue } from './cleanup.ts';
import type { EventType } from './event-types.ts';
import type { ExecutorUnavailable, QueueOrder } from './plugins.ts';
import type { RoutedBy } from './routing.ts'; import type { GradeRoute } from './grade-routing.ts';
import type { DeciderPolicy } from './decider-policy.ts';
import type { SignedOutTool, UsageLimitPair, UsageReading } from './usage.ts';
import type { ResourceReading } from './machine-history.ts'; import type { JobMachineLink, MachineDrained, MachineHerdr, MachineInfraCredentials, MachineLaneHealth, MachineLeaving, PendingLoad, UpdateSwap } from './machines.ts'; import type { MachineSandboxHost } from './sandbox-host.ts';
import type { ParkedElsewhere } from './checkpoints.ts'; import type { FailedProcessNote } from './failed-processes.ts';
import type { ActingPerson, ContinuedBy, JobAssessment, JobLiveness, ProblemBlock } from './failures.ts';
import type { PriorityLanesInput } from './priority.ts';
import type { BlastRadiusInput, GatePass } from './blast-radius.ts';
import type { OriginalKept, TextChange } from './item-snapshots.ts';
import type { ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView, JobOrigin, OriginActor } from './intake-origin.ts'; import type { LinkedPullRequest, RepoVisibility } from './linked-pulls.ts';
import type { JobPhaseFields } from './phase.ts';
import type { FollowOnOf } from './proposal-paths.ts';
import type { JobRework } from './pull-requests.ts';
import type { TaskCount } from './task-count.ts';
import type { JobNote } from './job-notes.ts';

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
  | 'waiting_on' // its own wait (issue #483): it waits on something it named; holds no lane; its pane stays open; no question
  | 'finished' | 'failed' | 'cancelled' | 'rejected'; // rejected: turned away at the queue gate, kept, never run

/**
 * The jobs directory (issue #314): the default work tree, below the home of the job's machine. A job never
 * runs with that home, or anything above it, as its work tree; this directory, and a work tree under it,
 * is made when missing.
 */
export const JOBS_DIR = '~/hopper-jobs';

/**
 * A job's own wait (issue #483): what it waits for, which only a person or the outside world can do (access granted, a
 * review); `until`, how it will know it happened (a check it runs in the background, an event), as it wrote it.
 * `ownCommand` (issue #1037): `until` names the job's own background command, so it waits on nothing outside the job and
 * shows as running. Then, while its pane shows no background work: `goneSince`, when that was first seen; `nudgedAt`, when
 * the hopper nudged its agent (once); `stuckAt`, when it was flagged stuck, a grace after the nudge (a wait from before issue
 * #1694: its wait check ends it now). `on` (issue #1245): what it waits on, typed; every wait since has one, and one without is
 * a legacy wait, stuck work. `polledAt` (issue #1210): when the hopper first saw its own command poll hopper state; `on` then
 * says what it polls. `check` (issue #1694): what the hopper tests of the wait and when, kept with it (wait-checks.ts).
 * `strandedAt` (issue #1779): a wait the hopper watches, not its pane, whose agent session ended — when that was first seen;
 * cleared when the agent is seen again. Only a person, or what it waits on, wakes it: stuck work, `stranded`.
 */
export interface JobWait { for: string; until?: string; since: string; on?: import('./wait-on.ts').WaitOn; ownCommand?: true; goneSince?: string; nudgedAt?: string; stuckAt?: string; strandedAt?: string; polledAt?: string; check?: import('./wait-checks.ts').WaitCheck; checkLine?: string }

export const TERMINAL_STATUSES: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];

/**
 * Whether a source item whose newest job is this one gets a new job: the job ended (finished,
 * failed, cancelled or rejected) and the source already reported that (so its marker, e.g. `hopper:done` or
 * `hopper:failed`, was written at least once). A source that offers the item again then means a
 * human cleared the marker. Unreported, the item is still the same attempt: a failing report must
 * not loop.
 */
export const isRerunnable = (job: Job): boolean => TERMINAL_STATUSES.includes(job.status) && job.sourceState?.sync?.finalReported === true;

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
  /**
   * `routedBy`: the routing rule that set this job's machine, executor, priority or work tree (issue #18), at intake or a
   * later sync (issue #375). `gradeRoute`: grade-aware routing gave it its executor (issue #2845): from which, and the grades.
   */
  routedBy?: RoutedBy; gradeRoute?: GradeRoute;
  /** Asked for a proposal (issue #537): its agent writes one instead of doing the work, and is told so after the job rules. */
  proposal?: true;
  /**
   * Asked to research (issue #543, #538): its agent writes a research report instead of doing the work. With `proposal`
   * too, it researches first and, once the research is accepted, writes the proposal (src/domain/review.ts REVIEW_KINDS).
   */
  research?: true;
  /**
   * Designated specialty (issue #762; its item labelled `hopper:specialty`): when it fits on no machine, it may elbow in —
   * start a lane past the machine's lane cap, within the machine's elbow-ins. No other job goes past the cap this way.
   */
  specialty?: true;
  /**
   * A tend job (issue #967): tending ran its item again (`job.rerun`, `by: "tending"`) to rebase its pull request or fix its
   * checks. It elbows in as a specialty job does, so a pull request's conflict never waits behind feature work for a lane.
   * `modelRoute`: what model routing chose at intake (issue #2848): the cheap or the strong model, why, and the job's budget. Absent: not routed.
   */
  tend?: true; modelRoute?: import('./model-routing.ts').ModelRoute;
}

/** What a job's source and routing rules give its spec (issue #375); `cwd`, `model`: the payload's. */
export interface SpecFromConfig { executor: string; model?: string; cwd?: string; machineId?: MachineId; rule?: string }

/** A job; its phase, switch and forks (issue #548) are declared in src/domain/phase.ts. */
export interface Job extends JobPhaseFields, JobMachineLink {
  id: JobId;
  /** A follow-on of an accepted proposal (issue #651): the job, proposal and path it continues. */
  followOn?: FollowOnOf;
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
  /**
   * Set while held because its item's text changed since the snapshot (issue #662): nothing starts it until a person
   * keeps the original text, accepts the new text, or cancels it.
   */
  textChange?: TextChange;
  /**
   * `originalKept`: a person kept the original text of its changed item: that live text holds it no more (issue #662).
   * `editSeen`: the last edit of its item a sync saw after the job started (issue #655 part 7): it lowered the job's
   * trust, and that live text lowers it no more. The job runs the text it started with.
   */
  originalKept?: OriginalKept; editSeen?: OriginalKept;
  /**
   * Set while its item's origin is not judged (issue #652, the backfill): a job of a GitHub source queued before origins
   * were judged (tenant migration 39). Held until a sync finds its issue of a trusted origin, or a person approves its
   * request card; then its `source.origin` is set and this goes.
   */
  /**
   * `stamp`: its trust stamp (issue #655, src/domain/trust-stamp.ts), its trust level signed. Absent: made before stamps, or outside the hopper.
   * `kindCheck`: Jev's kind check (issue #655, src/domain/kind-check.ts, the point `intake-kind` active), made before its first start.
   */
  originPending?: true; stamp?: import('./trust-stamp.ts').TrustStamp; kindCheck?: import('./kind-check.ts').KindCheck;
  /**
   * `userRank`: the job's place in the user order (0 first): set when the user orders the queue; ranked jobs run before the rest.
   * `critical`: the critical flag (issue #2203): a person marked the job critical, whatever its priority, so the critical job tracker shows it.
   */
  userRank?: number; critical?: true;
  laneId?: LaneId;
  /** Its task count (issue #794): done of total, as it last reported it. None before it has a task list. */
  tasks?: TaskCount;
  progressMessage?: string; result?: unknown;
  /** Finished partly done (issue #579): the URL of its own pull request that ships part of its item. */
  partlyDone?: string;
  error?: string;
  createdAt: string; // ISO
  updatedAt: string;
  startedAt?: string; finishedAt?: string;
  /** Incremented on every claim. */
  attempts: number;
  /** The job's work tree on its machine, as its executor reported it (issue #166); absent for an executor with none. */
  workTree?: string;
  /** Executor-owned state (e.g. herdr pane/agent ids), written via ExecutionContext.saveState. */
  executorState?: Record<string, unknown>;
  /** The open question this job waits on (status waiting_answer). */
  questionId?: string;
  /** Its proposal (issue #537): while it is open, the job waits on it (status waiting_answer, no question). */
  proposalId?: string;
  /** Its research report (issue #543): while it is open, the job waits on it, as on its proposal. */
  researchId?: string;
  /** An answer to deliver on the next claim: the job resumes instead of starting fresh. */
  pendingAnswer?: string;
  /**
   * A person's correction of an auto-answer the job got (issue #632): typed in ahead of the job's next answer, when it
   * resumes; a job running now gets it at its next stop, or at once when a person parks and re-queues it.
   */
  pendingCorrection?: string;
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
   * that claim reopens the session instead of typing into a pane. `auto` (issue #650): auto-park parked it, `why` says
   * so, and the answer to its question re-queues it with no pick up. `elsewhere` (issue #921): a person picked it up to
   * resume elsewhere — not pinned to its machine, its claim rebuilds its work tree from its checkpoint where it runs.
   * `checkpointAt` (issue #2335): the checkpoint taken after its agent ended; with it, its re-queue resumes it anywhere.
   * `by`, `via`, `reason` (issue #2167): the person who parked it, the way they did, and the reason they gave.
   * `parkAsk`: a running job's park, kept until its executor stepped aside and the park is recorded. `keptChat` (issue
   * #2848 part 3): its executor keeps its agent's chat to resume, with no agent session the hopper reads (a print-mode turn).
   */
  parked?: { at: string; from: 'running' | 'waiting_answer'; auto?: true; why?: string; elsewhere?: ParkedElsewhere; checkpointAt?: string; move?: import('./checkpoints.ts').ParkedMove; keptChat?: true } & import('./park-ask.ts').ParkAsk; parkAsk?: import('./park-ask.ts').ParkAsk;
  /**
   * Set when a person continued this failed job from Needs a person (issue #551): queued again with its failure and
   * their note pending, pinned to its machine. As for a parked job, kept until the resumed run records an outcome:
   * that claim reopens its agent session in its work tree. `handoffId`: the hand-off it resolved.
   */
  /** `preempted`: a job of higher priority took its lane (issue #1525, design.md "Preemption"), kept until it runs again. `memoryPaused`: its machine's memory fell below the floor (issue #2291), kept until it runs again. `waitReleased`: on its own wait, its agent was ended to free memory (issue #2303), kept until its resumed run records an outcome. `budgetPaused` (issue #2302, part 3): its token budget paused it, kept until a person picks it up. `budgetFrom`: what it had spent when a person let it go on past its budget; its budget counts from there. `jobBudget` (issue #2848, part 2): a person's caps on this job, over its model route's and the user's. */
  continued?: { at: string } & ContinuedBy; preempted?: import('./preemption.ts').JobPreempted; memoryPaused?: import('./memory-floor.ts').JobMemoryPaused; waitReleased?: import('./memory-floor.ts').JobWaitReleased; budgetPaused?: import('./token-budget.ts').JobBudgetPaused; budgetFrom?: import('./token-budget.ts').TokenSpend; jobBudget?: import('./model-routing.ts').JobBudget;
  /**
   * Its latest checkpoint (issue #921): its agent session and its work not pushed, copied from its machine while it ran.
   * The patch and the session are in the store's checkpoints.
   */
  checkpoint?: import('./checkpoints.ts').JobCheckpoint;
  /** Set while the job waits on something it named (issue #483, status `waiting_on`): what, how it will know, since when. */
  wait?: JobWait;
  /** What its source and routing rules last gave the spec (issue #375): a part differing from it was set by hand. Absent: the spec. */
  fromConfig?: SpecFromConfig;
  /** Where the job was pulled from. Absent only for jobs created before phase 3. */
  source?: JobSourceRef;
  /** The job this one runs again (a re-run, issue #354): the newest job of its source key when it was created. */
  rerunOf?: JobId;
  /** Set when this job reworks a pull request a person sent back (issue #724): it, the notes, who. */
  rework?: JobRework;
  /**
   * Notes a person sent the job (issue #997), oldest first: queued until its session gets them — at the next turn
   * boundary while it runs, with its task or the answer it resumes with —, or a new job of its item carries them.
   */
  notes?: JobNote[];
  /** When the user dismissed this failed job (issue #355): it is no longer a locked entry. */
  dismissedAt?: string;
  /**
   * Set while the job's cleanup is deferred (issue #371): it ended, but its executor could not reach the
   * job's machine to release what it holds there (its pane, its Claude), so that may still run. Tried
   * again on every tick until it goes through; meanwhile a waiting job of the same item is held.
   */
  cleanupDeferred?: { at: string; error: string };
  /**
   * Its cleanup's record (issue #1570): written in the transaction that recorded its end, removed once the cleanup went
   * through. A hopper that stops before then does the cleanup from it at its next start.
   */
  cleanupDue?: { at: string };
  /**
   * A person's discard of its kept work (issue #1570): kept until the removal on its machine ends. With no `error` it is
   * under way, and a sweep of its machine does it again after a stop; with one it failed (`job.work_discard_failed`).
   */
  discard?: { at: string; scratch: string; by: ActingPerson; error?: string };
  /** The output tail its executor gave when it failed (issue #509), codes hidden; the assessor's evidence. */
  errorTail?: string;
  /** What it showed of its progress when it timed out (issue #630): its executor's facts, and its source's. The assessor's evidence. */
  liveness?: JobLiveness;
  /** The failure assessor's judgement of this failed job (issue #509): its decision, summary and reasons. */
  assessment?: JobAssessment;
  /**
   * A job that ended well (`finished`) whose reap read a process of it that failed, or a scope it could not stop (issue
   * #2722 part 7): what its cards say after where it stands. Written by its cleanup, from its events.
   */
  failedProcesses?: FailedProcessNote;
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
  url?: string; title?: string;
  /** owner/repo for GitHub. */
  repo?: string;
  number?: number; author?: string;
  /** The login the job was taken for (issue #387). Absent on jobs taken before intake by assignee. */
  assignee?: string;
  labels?: string[]; // the item's labels at intake (issue #378); absent on jobs taken before
  /** The item's declared parts and how many are done, at intake (issue #729); absent: it declares none. */
  parts?: Parts;
  /**
   * Where the item came from (issue #652): a trusted origin, or a request card a person approved. Absent: neither — a job
   * of a source that does not judge origins, or one taken before origins were judged. Yolo mode does not read it (issue #805).
   */
  origin?: JobOrigin;
  /**
   * Its **origin acts** (issue #655 part 14): who wrote the item, who added the label and who assigned it (on GitLab also
   * who edited it), through which app, and whether a trusted actor did each, as read when its origin was judged. Absent
   * with no origin, or on a job taken before part 14. A record for people and for Jev's trust check: no rule reads it.
   */
  originActs?: OriginActor[];
  /**
   * Its repository's **visibility** and its **linked pull requests** (issue #655 part 19): the pull requests its text names,
   * who wrote each, whether its head is a fork and whether a trusted actor wrote it, as read when its origin was judged.
   * Absent as `originActs` is. A record for people and for Jev's trust check: no rule reads them (a job's pr edit reads its
   * item's approved text, issue #2227).
   */
  visibility?: RepoVisibility; linkedPulls?: LinkedPullRequest[];
}

/** An item's declared parts (issue #729): how many there are, and how many are done. */
export interface Parts { done: number; total: number }

/** The actions a router can advise — grok-bot-jev's router actions (src/router.py). */
export type AdviceAction =
  'proceed_full' | 'reuse_cache' | 'stop_retry' | 'run_deterministic' | 'chat_only' | 'ask_human' | 'allow_subagent' | 'research_capped';

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
  /**
   * `idleSince`: set when the lane last became idle; cleared when busy. `pastCap`: a reattach opened it past the lane cap,
   * no lane idle (issue #1181); it drains first, and is cleared when it goes idle.
   */
  idleSince?: string; pastCap?: true;
}

/** Point-in-time view of one machine, as polled by the engine. Its herdr, infra credentials, leaving, drained and unhealthy lanes: `MachineHerdr`, `MachineInfraCredentials`, `MachineLeaving`, `MachineDrained`, `MachineLaneHealth` (src/domain/machines.ts); its place in the sandbox host, `MachineSandboxHost` (src/domain/sandbox-host.ts). */
export interface MachineSnapshot extends MachineHerdr, MachineInfraCredentials, MachineLeaving, MachineDrained, MachineLaneHealth, MachineSandboxHost {
  id: MachineId;
  label: string;
  /** Hard ceiling on lanes this machine may run: in the engine, the lanes lane tuning applied in active mode (issue #688). */
  maxLanes: number;
  /**
   * The lanes it is configured with, when lane tuning applied others in active mode (issue #688). Absent: `maxLanes`.
   * `hostPool`: the host pool it shares one kernel with (issue #2622 part 7), every lane of the pool's machines and the
   * kernel's memory; set by the engine for a job's run (src/engine/job-run.ts `machineOf`), so the job's default memory limit
   * shares the kernel's memory by every lane on it. Absent: no pool.
   */
  configuredLanes?: number; hostPool?: { lanes: number; memTotalBytes: number };
  /** Lanes kept for jobs pinned to it (issue #372): jobs with no machine pin use at most its lane cap less these. Absent: 0. */
  reservedLanes?: number;
  /** How many lanes specialty jobs may elbow in past its lane cap at once (issue #762). Absent: 1. 0: none. `windows`: a Windows machine (issue #1350), the only kind that takes a job with a Windows label. `usageLimits`: its own usage limits (issue #1860), its lane cap goes by these, not by the user's; absent: the user's. */
  elbowIns?: number; windows?: true; usageLimits?: UsageLimitPair;
  online: boolean;
  /** Executors this machine can run. */
  executors: string[];
  /** An attached machine: the ssh destination its executors reach it by. Absent → this machine. */
  ssh?: string;
  /** A container target (issue #865): the image each of its commands runs in, a one-shot sandbox box of its own. */
  containerImage?: string;
  /** Its work tree (issues #324, #361): every job's there but one a routing rule pinned here with a path; `~` resolves on it. Absent: the jobs directory. */
  workTree?: string;
  /** A work tree per repository (issue #691), keyed `owner/name`, matched in any case: a job from one of them works there, not in `workTree`. */
  workTrees?: Record<string, string>;
  /** Why its work tree cannot be made usable, as its last probe found (issue #361): no job is routed to it. Absent: usable, or not probed yet. */
  workTreeProblem?: string;
  /** An ssh target: the hopper's address its last probe found it reaches, given to its jobs as HOPPER_URL (issue #698). Absent: none found, or not probed yet. */
  hopperUrl?: string;
  /** An ssh target: why its jobs cannot reach the hopper, as its last probe found (issue #698): no new job is routed to it. */
  addressProblem?: string;
  /** An ssh target with an address problem: the command that joins it to the hopper's network (issue #711). Absent: none fits. */
  addressFix?: string;
  /** An attached machine's home, as its probe found it: where `~` in a job's work tree resolves there (issue #323). Absent: not found yet, or this machine. */
  home?: string;
  /**
   * A client target: once probed online, the client release it runs (absent: it predates releases) and whether that is
   * the hopper's (issue #70); `update` when the hopper's release has not taken there after its tries, and why (issue #545);
   * `vault`: the vault's helper its client wrote, given to each job there as HOPPER_SECRET (issue #558); `door`: its
   * client door, the loopback URL there its jobs reach the hopper at, given to each as HOPPER_URL (issue #695);
   * `updateHold`: it ran another release than the hopper's too long while jobs were at work there, so it takes no job until
   * they end and the hopper's is loaded (issue #2715, src/machines/client-release.ts); `pendingLoad`: the load of the hopper's
   * release waits on jobs at work there, and `swapped`: it came by an update swap (issue #2738).
   */
  client?: { release?: string; current?: boolean; update?: { problem: string }; updateHold?: { since: string }; pendingLoad?: PendingLoad; swapped?: UpdateSwap; vault?: string; door?: string };
  /**
   * The disk its home is on, as last read (issue #401); `low` by its thresholds, and then it takes no new job (issue #410).
   * `critical` (issue #2494) by its critical thresholds: it takes no job at all, a job back to its pane included. Absent: not read (a container target, a client older than this).
   */
  disk?: { freeBytes: number; totalBytes: number; low: boolean; critical?: true }; diskThresholds?: import('./machines.ts').DiskThresholds; // diskThresholds: its own (issue #2494), the options it sets; the disk defaults fill in the rest (src/machines/disk-defaults.ts)
  /** Its CPU, memory and swap, as last read (issue #560): this machine at every list, an ssh target in its probe, a client target by its client. Absent: not read (a container target, a client older than this, offline). */
  resources?: ResourceReading;
  /**
   * A sandbox box (issue #558): the template its join line named, and why it takes no new job while that template is
   * not approved (issue #602): not saved, never approved, approval revoked, or its image changed since. Absent `waiting`: approved.
   */
  template?: { name: string; waiting?: string };
  /** How the sweep treats it (issue #410): how often, and how old an ended job's scratch dir gets there. Absent fields: the defaults. `memoryFloor`: its own memory floor (issue #2291); absent: the defaults. `jobLimits`: its limits for each job's scope (issue #2498); absent: none. */
  sweep?: import('./machines.ts').SweepSettings; memoryFloor?: import('./memory-floor.ts').MemoryFloor; jobLimits?: import('./job-limits.ts').JobLimits;
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
  /**
   * Issue #688. `expectedCosts`: each waiting job's expected cost, where one is known: a machine where it does not fit is
   * passed over. `placementPicks`: Jev's applied picks of a waiting job's machine (`job-machine`), taken first where the
   * job may go. Absent on Decisions stored before them: none. `signedOut` (issue #1128 part 5): the machines whose agent tool
   * reads signed out; no new job of its executors there. Absent on Decisions stored before it: none. `credentialHeld` (issue #1467):
   * the machines the credential check holds (an admin stopped them, or strict mode is on and no admin acknowledged them); a
   * machine with infra credentials that is not named takes jobs. Absent: none. `sandboxesHeld` (issue #1471): the waiting jobs
   * the sandboxes their prompt names hold (src/domain/sandboxes-before-start.ts), with why. Absent: none. `stampHeld`
   * (issue #655): the waiting jobs whose trust stamp is missing, does not verify, or is below the dispatch minimum, with why. Absent: none.
   * `budgetHeld` (issue #2302, part 5): the waiting jobs a day budget holds — the day's, or their repository's, is reached —, with why. Absent: none.
   */
  /**
   * Preemption (issue #1525): the minimum run time and the executors that park. Absent: off, and on Decisions stored before it.
   * `avoidLanes` (issue #2234): for a rerun of a job that failed for its lane's fault, that lane; it goes elsewhere when it can. Absent: none.
   * `parkingExecutors` (issue #2291): the executors that park, whose jobs a memory pause may name. Absent: none, and on Decisions stored before it.
   * `memoryPausedAt` (issue #2291): per machine, when this hopper last paused a job there for memory, as the paused job may be parked and not an input.
   * `waitSessions` (issue #2303): the jobs on their own wait whose agent the hopper may end to free memory. Absent: none.
   */
  avoidLanes?: Record<JobId, LaneId>; preemption?: import('./preemption.ts').PreemptionInput; parkingExecutors?: string[]; memoryPausedAt?: Record<MachineId, string>; waitSessions?: import('./memory-floor.ts').WaitSession[]; expectedCosts?: Record<JobId, import('./job-costs.ts').ExpectedCost>; placementPicks?: Record<JobId, import('./lane-tuning.ts').PlacementPick>; signedOut?: SignedOutTool[]; credentialHeld?: string[]; sandboxesHeld?: { jobId: JobId; reason: string }[]; stampHeld?: { jobId: JobId; reason: string }[]; budgetHeld?: { jobId: JobId; reason: string }[];
  policy: DeciderPolicy;
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
  /** `preempt`: running jobs to park so that a waiting job of higher priority takes their lanes (issue #1525). Absent: none. `memoryPause`: running jobs to park because their machine's memory is below its floor (issue #2291). Absent: none. `waitRelease`: jobs on their own wait whose agents end, a job waiting for memory on their machine (issue #2303). Absent: none. */
  advice: Divergence[]; preempt?: import('./preemption.ts').PreemptPlan[]; memoryPause?: import('./memory-floor.ts').MemoryPausePlan[]; waitRelease?: import('./memory-floor.ts').WaitReleasePlan[];
  /** Plain-language reasons, in the order the decider reached them. */
  reasons: string[];
  inputs: DecisionInputs;
}

// ---- Events ------------------------------------------------------------------------
export * from './event-types.ts';
export * from './checkpoints.ts';
export * from './job-notes.ts';

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

export type { DeliveryStatus, WebhookDelivery, WebhooksEdit } from './webhooks.ts';


// ---- Questions: src/domain/questions.ts (re-exported here) ----------------------------

export type * from './questions.ts';
export { ESCALATION_REASONS, LOGIN_SCREEN_MARK, NOT_SIGNED_IN, SIGNED_IN_ANSWER, SIGNED_IN_BY, SIGNED_OUT_MOVE_BY, signedOutMoveAnswer } from './questions.ts';

// ---- Sources: src/domain/sources.ts (re-exported here) ------------------------------------

export type { AfterAnswerTimed, AfterAnswerTiming, SourceCallLog, SourceCalls, SourceStatus, TimingSpread } from './sources.ts';

// ---- Attached machines: src/domain/machines.ts (re-exported here) ------------------------

export { HERDR_SESSION, HOST_KEY, type AttachedMachine, type CleanupProblem, type ClientMachine, type SandboxesView, type ConfiguredMachine, type ContainerMachine, type HerdrSide, type HerdrVersions, type MachineHerdr, type MachineDrain, type MachineDrains, type HostKeyOffer, type HostKeyOfferOutcome, type MachineDefaults, type MachineDefaultsEdit, type MachineEdit, type SshMachine, type MachineEditOutcome, type MachinesConfig, type WindowsHost, type WindowsHostsView, type PlaygroundLimits, type PlaygroundSandbox, type PlaygroundSize, type PlaygroundState, type PlaygroundView } from './machines.ts';

// ---- Routing rules: src/domain/routing.ts; plugins: src/domain/plugins.ts (re-exported here, one vocabulary) ----

export type * from './routing.ts';
export type { Account, ExecutorLaneEffect, MachineLaneEffect, PartAccount, SignedOutTool, UsagePacing, UsageLimitPair, UsageLimits, UsageReading, UsageReport, UsageSourceReport, UsageSourceState, UsageThrottle, ToolAccount, ToolAccountMachine, ToolAccountsReport, ToolLogin, ToolSignIn, ToolSignInStart } from './usage.ts';
export * from './usage-history.ts'; export type { HeaderBadge, HeaderBadgeSettings } from './header-badges.ts';
export * from './machine-history.ts'; export * from './hopper-disk.ts'; export * from './leftovers.ts'; export * from './disk-defaults.ts'; export type { CacheCaps, CappedKind } from './cache-caps.ts'; export type { DiskThresholds, EndStatus, SweepSettings } from './machines.ts';
export * from './stack-resources.ts'; export * from './telemetry-summary.ts';
export * from './lane-tuning.ts'; export type { GraphNode, LinkKind, NodeKind, SourceView, TopologyGraph, TopologyLink } from './topology.ts';
export type { CleanupDue, DeciderPolicy, ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView }; export type { AutoApproveRule, IntakeAutoApproval } from './intake-auto-approve.ts'; export type { DeclineChoice, IntakeDeclineDefaults } from './intake-decline.ts'; export type { IntakeStrictness, Strictness } from './intake-strictness.ts'; export type { SandboxStrictness, SandboxStrictnessLevel } from './sandbox-strictness.ts';
export * from './plugins.ts';
export * from './item-snapshots.ts';
export * from './check-logs.ts'; export type { WaitCheck, WaitCondition } from './wait-checks.ts';

// ---- Queue gate (issue #159): src/domain/queue-gate.ts (re-exported here) ---------------

export { DEFAULT_QUEUE_GATE, QUEUE_GATE_MODES, type GateActor, type PreSort, type PreSortReject, type QueueGate, type QueueGateMode } from './queue-gate.ts';

// ---- Logins (issue #476): src/domain/logins.ts (re-exported here) ----------------------

export * from './logins.ts';
export * from './review.ts';
export * from './proposal-paths.ts';
export * from './phase.ts';
export * from './sections.ts';
export * from './failures.ts';
export * from './kept-work.ts';
export * from './stuck.ts'; export * from './wait-on.ts';
export * from './yolo-mode.ts'; export * from './landing-batches.ts'; export * from './change-kinds.ts';
export * from './contribution.ts'; export * from './shrink-guard.ts';
export * from './pull-requests.ts';
export * from './pull-request-list.ts'; export * from './untracked-pull-requests.ts'; export type { JobActMarker } from './github-outbox.ts';
export * from './priority.ts';
export * from './blast-radius.ts';
export * from './minor-decisions.ts';
export * from './auto-answer.ts';
export * from './auto-park.ts'; export * from './preemption.ts'; export * from './memory-floor.ts';
export * from './thread-ask.ts';
export * from './access.ts';
export * from './state-backend.ts';
export * from './artifacts.ts';
export * from './tldr.ts';
export * from './pointed-jobs.ts';
export * from './job-graph.ts'; export * from './planned-work.ts'; export * from './planned-work-export.ts'; export type { PlanArtifactType, PlanSync } from './work-plans.ts';
export * from './github-watch.ts'; export * from './pending-approvals.ts';
export * from './drift.ts';

// ---- Question gates: src/domain/question-gates.ts (re-exported here) -------------------

export type { QuestionGatesView, RiskRuleView, RulesView } from './question-gates.ts';

// ---- Job rules (issue #172): src/domain/job-rules.ts (re-exported here) -------------------

export type { JobRulesView, RepoJobRulesView } from './job-rules.ts'; export type { ClusterOverride, ClustersView } from './clusters.ts';

// ---- Sign-in: src/domain/sign-in.ts (re-exported here) ------------------------------------

export type { ApiGrantMinted, ApiGrantView, GrantLimits, DeviceGrantAsk, DeviceGrantStarted, DeviceGrantView, ApiTokenMinted, ApiTokenRefreshed, ApiTokenSettings, ApiTokenView, GrantEndReason, ScopePermission, ScopePreset, ScopeRegistry, ScopeSection, Identity, PersonView, RealmSettings, RealmType, RealmView, RealmsEdit, RealmsView, SessionEndReason, SessionKind, SessionLengths, SessionUser, SessionView, SignInRealmView, UiRole, LocalAccountView, LocalAccountsView, LocalAccountsEdit, PasskeyView, PasskeysView } from './sign-in.ts';
export { API_TOKEN_MINUTES, API_TOKEN_PREFIX, DEVICE_CODE_PREFIX, DEVICE_GRANT, DPOP, JKT, GRANT_DEFAULT_DAYS, GRANT_END_REASONS, GRANT_IDLE_DAYS, GRANT_MAX_DAYS, REFRESH_GRACE_MS, REFRESH_TOKEN_PREFIX, DEFAULT_SESSION_LENGTHS, DEVICE_REALM_TYPES, FORM_REALM_TYPES, MAX_SESSION_HOURS, REALM_TYPES, REDIRECT_REALM_TYPES, SESSION_END_REASONS, UI_ROLES, lowerRole, roleAllows } from './sign-in.ts';

// ---- Users (issue #158): src/domain/users.ts (re-exported here) ---------------------------

export { ENDED_STATUSES, IN_FLIGHT_STATUSES, ADMIN_ID, type InstanceTotals, type UsageTotal, type User, type UserAdded, type UserView } from './users.ts';

// ---- Self-update (issue #44) ------------------------------------------------------------

export { isUpdateChannel, UPDATE_CHANNELS, type ClusterInstall, type InstallInfo, type InstallKind, type ShippedCompose, type StackDrift, type StackGap, type UpdateApply, type UpdateChannel, type UpdateSettings, type UpdateState, type UpdatePullRequest, type UpdateStatus, type UpdateTarget, type VersionEntry, type VersionHistory } from './update.ts';

// ---- Connected accounts (issue #214): src/domain/connected-accounts.ts --------------------------

export { CONNECTED_ACCOUNT_PROVIDERS, CONNECTED_VIA, furtherAccount, isConnectedAccountKey, providerOfKey, type AppInstallation, type AppInstallationsRead, type AppInstallationsReadRepository, type ConnectedAccountKey, type ConnectedAccountProvider, type ConnectedAccountStatus } from './connected-accounts.ts';
export * from './vault.ts';
export type { SandboxApprovals, SandboxRequestState, SandboxRequestView } from './sandbox-approvals.ts'; export type { RunCardView, TemplateWait } from './run-cards.ts';
export type { RememberedWrite, RememberedWriteView } from './remembered-writes.ts';
export * from './minting.ts';
export * from './master-key.ts';
