import type {
  Clock, ExecutorRegistry, IdGen, JevAdvisor, MachineSource, QuestionService, SettableUsageSource, Store, UsageSource,
} from '../domain/ports.ts';
import type { DeciderPolicy, JevMode } from '../domain/types.ts';

export interface EngineOptions {
  store: Store;
  clock: Clock;
  /** Decision ids. Defaults to randomUUID. */
  idGen?: IdGen;
  executors: ExecutorRegistry;
  machines: MachineSource;
  /** Every usage source the decider reads. Include `fakeUsage` here too when present. */
  usage: UsageSource[];
  /** The hand-settable source behind PUT /api/usage/fake, when one is composed. */
  fakeUsage?: SettableUsageSource;
  advisor: JevAdvisor;
  policy: DeciderPolicy;
  tickMs: number;
  /** Jev mode used only when the store has none yet. */
  initialJevMode: JevMode;
  /** The answer chain. Its onAnswered/onExpired must call the engine's (see main.ts). */
  questions: QuestionService;
  /** At most this many questions per job; the next one fails it (design.md B6). */
  maxQuestions: number;
  /** Skip executor cleanup on terminal outcomes (JOB_HOPPER_KEEP_PANES). */
  keepPanes: boolean;
}

/** What the engine's modules share. */
export interface EngineContext extends Required<Omit<EngineOptions, 'fakeUsage' | 'initialJevMode' | 'tickMs'>> {
  fakeUsage?: SettableUsageSource;
  jevMode(): JevMode;
  /** Ask for a Decision; coalesces with one already running. */
  trigger(reason: string): void;
  /** True once stop() began: nothing may write to the store after this. */
  stopping(): boolean;
}

export const nowIso = (c: { clock: Clock }): string => c.clock.now().toISOString();
