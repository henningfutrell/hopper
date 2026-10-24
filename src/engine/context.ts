import type {
  Clock, ExecutorRegistry, IdGen, JobProxyCredentials, MachineSource, QuestionService, ReviewServices, QueueSorter, Router, RoutingView, SettableUsageSource, UserStore, UsageSource,
} from '../domain/ports.ts';
import { jobPriorityTag, type CredentialRequest, type DeciderPolicy, type JevFirst, type TemplateRadius, type Job, type MachineSnapshot, type PriorityTag, type ProblemBlock, type Verdict } from '../domain/types.ts';
import type { Logins } from '../logins/index.ts';
import type { Checkpoints } from './checkpoints.ts';
import type { JobMoveData } from './lost-move.ts';
import type { JobRunData } from './job-run.ts';
import type { JobLeases } from './leases.ts';
import type { ReachHolds } from './reach-holds.ts';
import type { LaneHealth } from './lane-health.ts';
import type { JobPeaks } from './job-peaks.ts';
import type { WaitReads } from './wait-checks.ts';

export interface EngineOptions {
  store: UserStore;
  clock: Clock;
  /** Decision ids. Defaults to randomUUID. */
  idGen?: IdGen;
  executors: ExecutorRegistry;
  machines: MachineSource;
  /** The machine names in the plugins config (issue #919), undefined while it has an error: one gone from it is retired. Absent: none is. */
  configuredMachines?: () => readonly string[] | undefined;
  /** Every usage source the decider reads now: they follow the plugins config live (issue #356). Include `fakeUsage` here too when present. */
  usage: () => UsageSource[];
  /** The hand-settable source tests drive through `setFakeUsage`, when one is composed. */
  fakeUsage?: SettableUsageSource;
  /** The router role (live: the plugin host may swap its instance between calls). */
  router: Router;
  /** The queue-sorter role (live, like the router): the order of the waiting jobs, asked each Decision. */
  queueSorter: QueueSorter;
  /** The routing rules applied at intake, and the machine ids they may pin to. */
  routing: RoutingView;
  /** The policy from the environment. Its usage limits are the defaults: the user's stored ones win (issue #522), read by `policyOf`. */
  policy: DeciderPolicy;
  tickMs: number;
  /** How often the engine looks for a machine whose sweep is due (issue #410). Default a minute. */
  sweepCheckMs?: number;
  /**
   * The lease of each pass over the user's jobs or machines, by its name (issues #1627, #1662, `PASS_LEASES`): on several
   * hosts on one database, only its holder runs the pass. Absent: this host alone.
   */
  lease?: (name: string) => import('../domain/leases.ts').SweepLease;
  /** The answer chain. Its onAnswered/onExpired/onDismissed must call the engine's (see main.ts). */
  questions: QuestionService;
  /** Each review section's review (issues #537, #543). Their onDecided/onRevise must call the engine's; swept on each tick. */
  reviews: ReviewServices;
  /** The logins (issue #476): a login a job waits on; swept on each tick. */
  logins: Logins;
  /** At most this many questions per job; the next one fails it (design.md B6). */
  maxQuestions: number;
  /** After a restart, how long a running job whose machine does not answer yet stays running before it fails (issue #368). */
  reconnectGraceMs: number;
  /** Once a running job's machine link drops, how long it is held before it fails (issue #752). Default 10 min. */
  linkGraceMs?: number;
  /** A done job whose source finds it not done is asked again after this long, for GitHub's lag, before it fails (issue #637). Default 0: at once. */
  doneRecheckMs?: number;
  /** A done job whose source cannot be read is read again after this long, then after twice as long, before it fails (issue #2235). Default 5 s. */
  doneReadRetryMs?: number;
  /** A job waiting on its own command whose pane shows no background work this long is nudged once; this long after, stuck (issue #1037). Default 5 min. */
  ownCommandGraceMs?: number;
  /** Skip executor cleanup on terminal outcomes (HOPPER_KEEP_PANES). */
  keepPanes: boolean;
  /** Whether a job that ended done is done, partly done or not, asked of its source (`judge`, issues #171, #187, #579). */
  verdict: (job: Job) => Promise<Verdict>;
  /**
   * Why a running job's work is over at its source (`overAtSource`, issue #627): its pull request ready for review, its
   * issue closed; undefined: not over, or the source cannot tell. Asked before a nudge. Absent: never over.
   */
  overAtSource?: (job: Job) => Promise<string | undefined>;
  /** The credential requests open for a person (issue #583), each with the jobs that wait on it. Asked before a nudge (issue #627). Absent: none. */
  credentialRequests?: () => readonly CredentialRequest[];
  /** What a job on this machine asks the hopper's GitHub proxy with (issue #563); undefined: the machine cannot reach the hopper. Absent: none. */
  jobProxy?: (job: Job, machine: MachineSnapshot) => JobProxyCredentials | undefined;
  /**
   * The agent's sign-in a job on this machine starts with (issue #1287, design.md "The agent's sign-in in a lane pod"): the
   * variable and its value, `none`, or why the vault refuses it (the job fails). Absent: none on any machine.
   */
  agentSignIn?: (job: Job, machine: MachineSnapshot) => Promise<{ variable: string; value: string } | { none: true } | { refused: string }>;
  /**
   * The values of the vault secrets the vault delivered to a job (issue #1957, `Vault.deliveredTo`): its checkpoint is
   * scrubbed of them by value. Absent: none.
   */
  deliveredSecrets?: (jobId: string) => Promise<readonly string[]>;
  /**
   * The job's trace context (issue #1486, design.md "Telemetry: a job's trace on its machine"): the variables its processes
   * run with to join its trace (`TRACEPARENT`). Empty while telemetry is off. Absent: none.
   */
  traceContext?: (jobId: string) => Readonly<Record<string, string>>;
  /** A box's template and its rating now (issue #605): the box's blast radius includes it. Absent: no machine is a box. */
  boxRadius?: (machineId: string) => { name: string; radius: TemplateRadius } | undefined;
  /** The open problems that hold or redirect jobs (issue #509), read at each Decision. */
  problems: () => ProblemBlock[];
  /**
   * Issue #1471, design.md "Sandboxes before the start": asks for the sandboxes each waiting job's prompt names, and
   * answers the jobs they hold, with why; read at each Decision. Absent: none.
   */
  sandboxesHeld?: (waiting: readonly Job[]) => { jobId: string; reason: string }[];
  /**
   * Set a machine's configured lanes as an admin's edit of the machine sets them (issue #688): an applied lane
   * recommendation and its undo. Throws an EngineError when refused. Absent: refused.
   */
  machineLanes?: (machineId: string, lanes: number) => Promise<void>;
  /** Decider calls through Jev first (issue #550): a machine's lanes and a waiting job's machine (issue #688). Absent: Jev is never asked. */
  jevFirst?: JevFirst;
  /**
   * Begins the `job-move` saga of a job that moves off its lost machine (issue #1569, lost-move.ts), one per `key`. Absent: a
   * job whose machine stays away fails, as nothing would end the agent it left there.
   */
  jobMoves?: { begin(key: string, data: JobMoveData): void };
  /**
   * The `job-run` saga (issue #1662, job-run.ts): `begin` keeps one per job and attempt, which the saga coordinator drives on
   * whichever hopper holds it, and says whether a new one does (false: one of that key ended already); `open`, the jobs of
   * `jobIds` whose job-run saga has not ended. Absent: the runner drives each run itself, and a stop leaves it to recovery.
   */
  jobRuns?: { begin(key: string, data: JobRunData): boolean; open(jobIds: readonly string[]): Set<string> };
  /** How long a job lease holds without a renewal (issue #1662): the most a hopper that crashed keeps its jobs from the others. Default a minute. */
  jobLeaseMs?: number;
  /** What a wait check of items reads (issue #1694, wait-checks.ts): the job's source. Absent: such a check reads nothing, and waits for its deadline. */
  waitReads?: WaitReads;
}

/** What the engine's modules share. */
export interface EngineContext extends Required<Omit<EngineOptions, 'fakeUsage' | 'tickMs' | 'sweepCheckMs' | 'lease' | 'jobMoves' | 'jobRuns' | 'jobLeaseMs' | 'waitReads'>> {
  fakeUsage?: SettableUsageSource;
  jobMoves?: EngineOptions['jobMoves']; jobRuns?: EngineOptions['jobRuns']; waitReads?: WaitReads;
  /** Ask for a Decision; coalesces with one already running. */
  trigger(reason: string): void;
  /** True once stop() began: nothing may write to the store after this. */
  stopping(): boolean;
  /** The job checkpoints (issue #921); set once the engine made them. */
  checkpoints?: Checkpoints;
  /** This hopper's job leases (issue #1662). */
  leases: JobLeases;
  /** The machines a job's start found out of reach of the hopper (issue #1920): they take no new job for a while. Absent: none is held. */
  reachHolds?: ReachHolds;
  /** The lanes whose starts failed again and again the same way (issue #2234): they take no new job for a while. Absent: none is out. */
  laneHealth?: LaneHealth;
  /** The most memory each job's machine's meter said it held (issue #2737): the cleanup's peak where the reap read none. Absent: none kept. */
  jobPeaks?: JobPeaks;
}

export const nowIso = (c: { clock: Clock }): string => c.clock.now().toISOString();

/** The job's live priority and whether it is high priority (issue #535), for the events that tell of it; {} without the job. */
export const priorityTagOf = (c: { store: UserStore }, jobId: string): PriorityTag | Record<string, never> =>
  jobPriorityTag(c.store.jobs, c.store.settings.getPriorityLanes(), jobId) ?? {};

/** The policy the decider uses now: the usage limits the user set in the UI (issue #522), else the environment's. */
export function policyOf(c: Pick<EngineContext, 'policy' | 'store'>): DeciderPolicy {
  const set = c.store.settings.getUsageLimits();
  if (!set) return c.policy;
  return { ...c.policy, softLimit: set.soft, hardLimit: set.hard, ...(set.softLanes === undefined ? {} : { softLanes: set.softLanes }) };
}
