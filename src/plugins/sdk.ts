// The plugin SDK: every type a plugin is written against (design.md "Plugin contract").
// Out-of-tree plugins import it type-only as `hopper/plugin` (package.json `exports`), which
// type stripping erases, so a plugin needs nothing of hopper at runtime. Types only here.
import type { z } from 'zod';
import type {
  AnswerRequest, Clock, EscalationLevel, ExecutionContext, ExecutionOutcome, Executor, JobSource, LevelReply,
  MachineSource, Notifier, NotifierEvents, QueueEntry, QueueSorter, Router, SourceItem, SourceReport, SourceSignal, UsageSource,
} from '../domain/ports.ts';
import type { Advice, AdviceAction, AttachedMachine, Detection, DomainEvent, Job, MachineSnapshot, Question, QuestionAttempt, Role, RouterMode, UsageReading } from '../domain/types.ts';

export type {
  Advice, AdviceAction, AnswerRequest, AttachedMachine, Clock, Detection, DomainEvent, EscalationLevel, ExecutionContext, LevelReply,
  ExecutionOutcome, Executor, Job, JobSource, MachineSnapshot, MachineSource, Notifier, NotifierEvents, Question, QuestionAttempt, QueueEntry,
  QueueSorter, Role, Router, RouterMode, SourceItem, SourceReport, SourceSignal, UsageReading, UsageSource,
};

/** What `detect` may use. Cheap; never a paid model call; never runs a GUI binary. */
export interface DetectionKit {
  /** Absolute path of an executable on PATH (or the path itself if absolute and executable). */
  which(bin: string): Promise<string | undefined>;
  /** First line of `bin args` stdout (default `--version`), or undefined on failure or after 5 s. CLIs only. */
  version(bin: string, args?: string[]): Promise<string | undefined>;
  /** Whether `bin args` exits 0 within 5 s (output discarded). CLIs only. */
  succeeds(bin: string, args: string[]): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Whether this process can read `path`. */
  readable(path: string): Promise<boolean>;
  /** Whether `python -c "import <module>"` succeeds. */
  pythonImports(python: string, module: string): Promise<boolean>;
  /** A value the runtime gives, as PluginContext.env. */
  env(name: string): string | undefined;
}

export interface PluginLogger {
  info(line: string): void;
  warn(line: string): void;
}

/** Given to every plugin's `create`. */
export interface PluginContext {
  clock: Clock;
  logger: PluginLogger;
  /** hopper's data dir (next to its database). */
  dataDir: string;
  /** This plugin's own scratch dir (`<dataDir>/plugin-data/<id>`), created before `create`. */
  scratchDir: string;
  /** The instance's name in plugins.yaml. A job source and a machine source are known by it. */
  instanceName: string;
  /**
   * A value the runtime gives: the variable `name`, or the mounted file the variable `<name>_FILE`
   * names, read at each call. Where every secret comes from (design.md "Secrets"); throws when both are
   * set or the file cannot be read.
   */
  env(name: string): string | undefined;
}

/**
 * A job source instance: the source the sync loop runs, with its own cadence — or, when its options
 * switch it off, only a `disabled` entry in /api/sources. `source.name` must be the instance name.
 */
export type JobSourceInstance =
  | { source: JobSource; pollMs: number }
  | { disabled: { kind: string; detail: Record<string, unknown> } };

/**
 * What each role's `create` returns. The core names the instance after plugins.yaml (`name` is
 * overridden: jobs name an executor instance, a question's stage names an escalation-level
 * instance), validates every level's reply, and fails closed on it.
 */
export interface RoleInstance {
  router: Router;
  'queue-sorter': QueueSorter;
  'escalation-level': EscalationLevel;
  executor: Executor;
  'job-source': JobSourceInstance;
  'machine-source': MachineSource;
  'usage-source': UsageSource;
  notifier: Notifier;
}

/**
 * What each role adds to the context. The router passes hopper's router mode on (Jev reads it);
 * a job source learns which source keys already have jobs; a machine
 * source learns the executors registered when it is asked.
 */
export interface RoleContext {
  router: { routerMode(): RouterMode };
  'queue-sorter': object;
  'escalation-level': object;
  executor: object;
  'job-source': JobSourceContext;
  'machine-source': MachineSourceContext;
  'usage-source': object;
  notifier: object;
}

/**
 * What a machine source learns: the executors registered when it is asked, and how the hopper reaches
 * an attached machine (design.md "Attached machines", issue #74) — a source listing it, online while
 * its probe says so, probed in the background. One machine keeps its probe while only its lanes,
 * executors or label change.
 */
export interface MachineSourceContext {
  executors(): string[];
  target(machine: AttachedMachine): MachineSource;
}

export interface JobSourceContext {
  /** Of these source keys, those that already have a local job. */
  knownKeys(keys: string[]): Set<string>;
  /** Of these source keys, those whose newest job may be re-run. */
  rerunnable(keys: string[]): Set<string>;
}

/** The zod the core passes to `options` — authors need not import zod. */
export type Zod = typeof z;

/**
 * One plugin: one ES module whose default export is this. `O` is the validated options type;
 * with `satisfies PluginDefinition<'router'>` it is inferred loosely (`any`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options are whatever the plugin's own schema says
export interface PluginDefinition<R extends Role = Role, O = any> {
  /** Unique; a custom id equal to a built-in id is refused. Lowercase, digits, dashes. */
  id: string;
  role: R;
  /** One line for /api/plugins and the UI. */
  describe: string;
  /**
   * Options schema built from the core's zod. Absent → no options. Validated before detect and
   * create. Mark every option naming a program, its arguments, a working directory, an
   * interpreter, a sourced file, or where a credential is read or sent with `.meta({ commandBearing: true })`: the UI shows it
   * read-only (design.md "UI and mutation").
   */
  options?: (z: Zod) => z.ZodType<O>;
  /** Can it run here, with these options? */
  detect(sys: DetectionKit, options: O): Promise<Detection>;
  create(ctx: PluginContext & RoleContext[R], options: O): RoleInstance[R] | Promise<RoleInstance[R]>;
}
