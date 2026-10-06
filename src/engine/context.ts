import type {
  Clock, ExecutorRegistry, IdGen, MachineSource, QuestionService, QueueSorter, Router, RoutingView, SettableUsageSource, UserStore, UsageSource,
} from '../domain/ports.ts';
import type { DeciderPolicy, Job, RouterMode } from '../domain/types.ts';

export interface EngineOptions {
  store: UserStore;
  clock: Clock;
  /** Decision ids. Defaults to randomUUID. */
  idGen?: IdGen;
  executors: ExecutorRegistry;
  machines: MachineSource;
  /** Every usage source the decider reads. Include `fakeUsage` here too when present. */
  usage: UsageSource[];
  /** The hand-settable source tests drive through `setFakeUsage`, when one is composed. */
  fakeUsage?: SettableUsageSource;
  /** The router role (live: the plugin host may swap its instance between calls). */
  router: Router;
  /** The queue-sorter role (live, like the router): the order of the waiting jobs, asked each Decision. */
  queueSorter: QueueSorter;
  /** The routing rules applied at intake, and the machine ids they may pin to. */
  routing: RoutingView;
  policy: DeciderPolicy;
  tickMs: number;
  /** Router mode used only when the store has none yet. */
  initialRouterMode: RouterMode;
  /** The answer chain. Its onAnswered/onExpired/onDismissed must call the engine's (see main.ts). */
  questions: QuestionService;
  /** At most this many questions per job; the next one fails it (design.md B6). */
  maxQuestions: number;
  /** Skip executor cleanup on terminal outcomes (HOPPER_KEEP_PANES). */
  keepPanes: boolean;
  /** Why a job that ended done is not complete, asked of its source (JobSource.notComplete, issues #171, #187). */
  notComplete: (job: Job) => Promise<string | undefined>;
}

/** What the engine's modules share. */
export interface EngineContext extends Required<Omit<EngineOptions, 'fakeUsage' | 'initialRouterMode' | 'tickMs'>> {
  fakeUsage?: SettableUsageSource;
  routerMode(): RouterMode;
  /** Ask for a Decision; coalesces with one already running. */
  trigger(reason: string): void;
  /** True once stop() began: nothing may write to the store after this. */
  stopping(): boolean;
}

export const nowIso = (c: { clock: Clock }): string => c.clock.now().toISOString();
