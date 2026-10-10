// The plugin SDK: every type a plugin is written against (design.md "Plugin contract").
// Out-of-tree plugins import it type-only as `hopper/plugin` (package.json `exports`), which
// type stripping erases, so a plugin needs nothing of hopper at runtime. Types only here.
import type { z } from 'zod';
import type { IntakeContext } from '../domain/intake.ts';
import type {
  AnswerRequest, Clock, ConnectedAccountTokens, EscalationLevel, ExecutionContext, ExecutionOutcome, Executor, JobSource, LevelReply,
  MachineSource, Notifier, NotifierEvents, QueueEntry, QueueSorter, ReviewReply, ReviewRequest, Router, SourceItem, SourceReport, SourceSignal, UsageSource,
} from '../domain/ports.ts';
import type { VaultBackend } from '../domain/vault.ts';
import type { ClientTransport } from '../executors/client.ts';
import type { Advice, AdviceAction, AttachedMachine, Detection, OptionChoice, DomainEvent, Job, MachineSnapshot, NotifierActionResult, PreSortReject, Question, QuestionAttempt, RaisedBy, Role, UsageReading } from '../domain/types.ts';
import type { Rejection } from '../domain/rejection.ts';

export type {
  Advice, AdviceAction, AnswerRequest, AttachedMachine, Clock, ConnectedAccountTokens, Detection, DomainEvent, EscalationLevel, ExecutionContext, LevelReply,
  ExecutionOutcome, Executor, Job, JobSource, MachineSnapshot, MachineSource, Notifier, NotifierActionResult, NotifierEvents, PreSortReject, Question, QuestionAttempt, QueueEntry, RaisedBy,
  QueueSorter, ReviewReply, ReviewRequest, Role, Router, SourceItem, SourceReport, SourceSignal, UsageReading, UsageSource, VaultBackend,
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
  /** All of `bin args` stdout, with `input` on stdin, or undefined on failure or after 5 s. CLIs only. */
  output(bin: string, args: string[], input: string): Promise<string | undefined>;
  /** Whether `python -c "import <module>"` succeeds. */
  pythonImports(python: string, module: string): Promise<boolean>;
  /** A value the runtime gives, as PluginContext.env. */
  env(name: string): string | undefined;
  /** The runtime's name for secret `name`, as PluginContext.secretName. */
  secretName(name: string): string;
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
  /** The instance's name in the plugins config. A job source and a machine source are known by it. */
  instanceName: string;
  /**
   * A value the runtime gives: the variable `name`, or the mounted file the variable `<name>_FILE`
   * names, read at each call. Where every secret comes from (design.md "Secrets"); throws when both are
   * set or the file cannot be read.
   */
  env(name: string): string | undefined;
  /**
   * The runtime's name for secret `name`: the user's secret prefix and the name (issue #158), so
   * `HOPPER_USER_<ID>_<name>` for a user added later. What to tell the person to set; `env` reads it.
   */
  secretName(name: string): string;
  /**
   * What the user's processes add to the daemon's environment (issue #158): the gh and claude CLIs'
   * config dirs (`GH_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`) of a user added later; empty for the first
   * user. A part that starts a process on this machine starts it with these over `process.env`.
   */
  userEnv: Readonly<Record<string, string>>;
}

/**
 * A job source instance: the source the sync loop runs, with its own cadence — or, when its options
 * switch it off, only a `disabled` entry in /api/sources. `source.name` must be the instance name.
 */
export type JobSourceInstance =
  | { source: JobSource; pollMs: number }
  | { disabled: { kind: string; detail: Record<string, unknown> } };

/**
 * What each role's `create` returns. The core names the instance after the plugins config (`name` is
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
  'vault-backend': VaultBackend;
}

/**
 * What each role adds to the context. A job source learns which source keys already have jobs; a machine
 * source learns the executors registered when it is asked; a usage source and an escalation level find a machine.
 */
export interface RoleContext {
  router: object;
  'queue-sorter': object;
  'escalation-level': EscalationLevelContext;
  executor: ExecutorContext;
  'job-source': JobSourceContext;
  'machine-source': MachineSourceContext;
  'usage-source': UsageSourceContext;
  notifier: object;
  'vault-backend': object;
}

/** A machine by its id, as the machine sources list it now (absent: not configured, or its source cannot run); and all of them. */
export interface MachineLookup {
  machine(id: string): Promise<MachineSnapshot | undefined>;
  /** Every machine the machine sources list now: a part that names no machine picks one of them (issue #442). */
  machines(): Promise<MachineSnapshot[]>;
}

/** What an escalation level learns: the machines, the default escalation machine of the plugins config (issue #442), read at each call, and how to reach a client target (issue #482). */
export interface EscalationLevelContext extends MachineLookup, Pick<ExecutorContext, 'client'> {
  escalationMachine(): string | undefined;
}

/**
 * What a usage source learns: a machine, so a source can read the account of that machine (issue #139),
 * and how to reach it when it is a client target (issue #366). An escalation level learns the machine
 * too, so it can run on its designated machine (issue #150).
 */
export type UsageSourceContext = MachineLookup & Pick<ExecutorContext, 'client'>;

/**
 * What a machine source learns: the executors registered when it is asked, and how the hopper reaches
 * an attached machine (design.md "Attached machines", issue #74) — a source listing it, online while
 * its probe says so, probed in the background. One machine keeps its probe while only its lanes,
 * executors or label change.
 */
/** What an executor learns (issue #308): how to reach a client target, by its machine id; undefined when no client target has it. */
export interface ExecutorContext {
  client(machine: string): ClientTransport | undefined;
}

export interface MachineSourceContext {
  executors(): string[];
  target(machine: AttachedMachine): MachineSource;
}

export interface JobSourceContext {
  /** Of these source keys, those that already have a local job. */
  knownKeys(keys: string[]): Set<string>;
  /** Of these source keys, those whose newest job may be re-run. */
  rerunnable(keys: string[]): Set<string>;
  /**
   * Of these source keys, those whose newest job was rejected (issue #387): when, and the assignee it was
   * taken for — so a source does not take a rejected item again until it is handed to the user again.
   */
  rejections(keys: string[]): Map<string, Rejection>;
  /** The user's connected GitHub account (issue #214): who it is, and a token for a call. */
  connectedAccounts: ConnectedAccountTokens;
  /** For the source of this instance name: claim holders, the intake migration and intake events (issue #440); undefined: none kept. */
  intake(sourceName: string): IntakeContext | undefined;
  /** Whether a job on this repository (`owner/repo`) may merge its own pull request: the user's yolo mode (issue #579), read at each call. */
  yoloMode(repo: string): boolean;
  /** The artifacts a job made (issue #673): each one's id and the URL of the issue it is linked to. */
  jobArtifacts(jobId: string): { id: string; issue?: string }[];
}

export type { OptionChoice };

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
   * interpreter, a sourced file, or where a credential is read or sent with `.meta({ commandBearing: true })`: the UI edits it
   * like any option and says what it is (design.md "UI and mutation", issue #198).
   */
  options?: (z: Zod) => z.ZodType<O>;
  /** Can it run here, with these options? */
  detect(sys: DetectionKit, options: O): Promise<Detection>;
  /**
   * Option choices: the values an option may take, read from the system (the models a CLI offers),
   * by option name. The UI offers them instead of a typed value. Run at start and on rescan; same
   * limits as `detect`. Absent, empty or throwing → the options are typed.
   */
  choices?(sys: DetectionKit): Promise<Record<string, OptionChoice[]>>;
  create(ctx: PluginContext & RoleContext[R], options: O): RoleInstance[R] | Promise<RoleInstance[R]>;
}
