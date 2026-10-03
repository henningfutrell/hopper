import type {
  Clock, ExecutorRegistry, IdGen, MachineSource, QuestionService, Router, SettableUsageSource, Store, UsageSource,
} from '../domain/ports.ts';
import type { DeciderPolicy, RouterMode } from '../domain/types.ts';

export interface EngineOptions {
  store: Store;
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
  policy: DeciderPolicy;
  tickMs: number;
  /** Router mode used only when the store has none yet. */
  initialRouterMode: RouterMode;
  /** The answer chain. Its onAnswered/onExpired must call the engine's (see main.ts). */
  questions: QuestionService;
  /** At most this many questions per job; the next one fails it (design.md B6). */
  maxQuestions: number;
  /** Skip executor cleanup on terminal outcomes (JOB_HOPPER_KEEP_PANES). */
  keepPanes: boolean;
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
