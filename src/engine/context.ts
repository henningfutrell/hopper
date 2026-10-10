import type {
  Clock, ExecutorRegistry, IdGen, JobCredentials, JobProxyCredentials, MachineSource, QuestionService, ReviewServices, QueueSorter, Router, RoutingView, SettableUsageSource, UserStore, UsageSource,
} from '../domain/ports.ts';
import { jobPriorityTag, type CredentialRequest, type DeciderPolicy, type TemplateRadius, type Job, type MachineSnapshot, type PriorityTag, type ProblemBlock, type Verdict } from '../domain/types.ts';
import type { Logins } from '../logins/index.ts';

export interface EngineOptions {
  store: UserStore;
  clock: Clock;
  /** Decision ids. Defaults to randomUUID. */
  idGen?: IdGen;
  executors: ExecutorRegistry;
  machines: MachineSource;
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
  /** A done job whose source finds it not done is asked again after this long, for GitHub's lag, before it fails (issue #637). Default 0: at once. */
  doneRecheckMs?: number;
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
  /** What a job's processes act with, from its source's connection (JobSource.credentials, issues #214, #441). */
  credentials: (job: Job) => Promise<JobCredentials | undefined>;
  /** What a job on this machine asks the hopper's GitHub proxy with (issue #563); undefined: the machine cannot reach the hopper. Absent: none. */
  jobProxy?: (job: Job, machine: MachineSnapshot) => JobProxyCredentials | undefined;
  /** A box's template and its rating now (issue #605): the box's blast radius includes it. Absent: no machine is a box. */
  boxRadius?: (machineId: string) => { name: string; radius: TemplateRadius } | undefined;
  /** The open problems that hold or redirect jobs (issue #509), read at each Decision. */
  problems: () => ProblemBlock[];
}

/** What the engine's modules share. */
export interface EngineContext extends Required<Omit<EngineOptions, 'fakeUsage' | 'tickMs' | 'sweepCheckMs'>> {
  fakeUsage?: SettableUsageSource;
  /** Ask for a Decision; coalesces with one already running. */
  trigger(reason: string): void;
  /** True once stop() began: nothing may write to the store after this. */
  stopping(): boolean;
}

export const nowIso = (c: { clock: Clock }): string => c.clock.now().toISOString();

/** The job's live priority and whether it is high priority (issue #535), for the events that tell of it; {} without the job. */
export const priorityTagOf = (c: { store: UserStore }, jobId: string): PriorityTag | Record<string, never> =>
  jobPriorityTag(c.store.jobs, c.store.settings.getPriorityLanes(), jobId) ?? {};

/** The policy the decider uses now: the usage limits the user set in the UI (issue #522), else the environment's. */
export function policyOf(c: Pick<EngineContext, 'policy' | 'store'>): DeciderPolicy {
  const set = c.store.settings.getUsageLimits();
  return set ? { ...c.policy, softLimit: set.soft, hardLimit: set.hard } : c.policy;
}
