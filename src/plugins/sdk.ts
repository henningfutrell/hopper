// The plugin SDK: every type a plugin is written against (design.md "Plugin contract").
// Out-of-tree plugins import it type-only as `hopper/plugin` (package.json `exports`), which
// type stripping erases, so a plugin needs nothing of hopper at runtime. Types only here.
import type { DoneCriterion } from '../domain/conditional-skills.ts';
import type { z } from 'zod';
import type { IntakeContext, IntakeTrust } from '../domain/intake.ts';
import type {
  AnswerRequest, Clock, ConnectedAccountTokens, EscalationLevel, ExecutionContext, ExecutionOutcome, Executor, JobSource, LevelReply,
  MachineSource, Notifier, NotifierEvents, QueueEntry, QueueSorter, ReviewReply, ReviewRequest, Router, SourceItem, SourceReport, SourceSignal, UsageSource,
} from '../domain/ports.ts';
import type { VaultBackend } from '../domain/vault.ts';
import type { CommandBoxes } from '../domain/sandboxes.ts';
import type { InfraPlanNotice } from '../domain/infra-watchers.ts';
import type { ClientTransport } from '../executors/client.ts';
import type { Advice, ChangeRule, AdviceAction, AttachedMachine, Detection, OptionChoice, DomainEvent, Job, MachineSnapshot, NotifierActionResult, PreSortReject, Question, QuestionAttempt, RaisedBy, Role, ToolSignIn, UsageReading } from '../domain/types.ts';
import type { Rejection } from '../domain/rejection.ts';
import type { IssueGraphRepository } from '../domain/issue-graph.ts';
import type { GitHubListingRepository } from '../domain/github-listing.ts';
import type { GitHubOutboxRepository } from '../domain/github-outbox.ts';
import type { GitMirrors } from '../git-mirror/mirrors.ts';
import type { GitLabAccount } from '../gitlab/account.ts';

export type {
  Advice, AdviceAction, AnswerRequest, AttachedMachine, Clock, ConnectedAccountTokens, Detection, DomainEvent, EscalationLevel, ExecutionContext, LevelReply,
  ExecutionOutcome, Executor, InfraPlanNotice, Job, JobSource, MachineSnapshot, MachineSource, Notifier, NotifierActionResult, NotifierEvents, PreSortReject, Question, QuestionAttempt, QueueEntry, RaisedBy,
  QueueSorter, ReviewReply, ReviewRequest, Role, Router, SourceItem, SourceReport, SourceSignal, ToolSignIn, UsageReading, UsageSource, VaultBackend,
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
export type UsageSourceContext = MachineLookup & Pick<ExecutorContext, 'client'> & {
  /**
   * The agent's sign-in a read on `machine` runs with (issue #1287, design.md "The agent's sign-in in a lane pod"): a lane
   * pod's user's setup token, as its jobs start with; none on any other machine, which keeps its own sign-in; or why not.
   * Absent: none.
   */
  agentSignIn?(machine: string): Promise<{ variable: string; value: string } | { none: true } | { refused: string }>;
};

/**
 * What a machine source learns: the executors registered when it is asked, and how the hopper reaches
 * an attached machine (design.md "Attached machines", issue #74) — a source listing it, online while
 * its probe says so, probed in the background. One machine keeps its probe while only its lanes,
 * executors or label change.
 */
/** What an executor learns (issue #308): how to reach a client target, by its machine id; undefined when no client target has it. */
export interface ExecutorContext extends Partial<Pick<MachineLookup, 'machine'>> {
  client(machine: string): ClientTransport | undefined;
  /** Job pods (issue #1283): what a pod per job needs of the hopper. Absent: no job pod can join this hopper. */
  pods?: JobPodHost;
  /** A container target's command boxes, through the sandbox module (issue #865). Absent: this hopper starts none. */
  boxes?: CommandBoxes;
}

/** What the hopper does for a job pod (issue #1283, design.md "Job pods on Kubernetes"). */
export interface JobPodHost {
  /** A fresh join code for the user, naming the pod: the pod joins once with it, as a machine only its job runs on. */
  join(pod: string): string;
  /** Removes the machine the pod joined as; none is no error. */
  leave(pod: string): Promise<void>;
  /** The hopper's instance id: the label that makes a pod this hopper's. */
  instanceId(): string;
  /**
   * The job's user's vault secret `name` for the job's pod (issue #1287): a Claude setup token the pod's panes sign in
   * with; `none` when the user holds no such secret; or why the vault refuses it. Absent: no vault, nothing is given.
   */
  agentCredential?(ask: { name: string; pod: string; job: string }): Promise<{ name: string; value: string } | { none: true } | { refused: string }>;
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
  /** The user's GitLab account (issue #1448 part 2): its status and the issues of its picked projects. Absent: none here. */
  gitlabAccount?: GitLabAccount;
  /** For the source of this instance name: claim holders, the intake migration and intake events (issue #440); undefined: none kept. */
  intake(sourceName: string): IntakeContext | undefined;
  /** The user's trusted actors and approved requests (issue #652): what an item's origin is judged by. */
  intakeTrust: IntakeTrust;
  /** Whether a job on this repository (`owner/repo`) may merge its own pull request: the user's yolo mode (issue #579), read at each call. */
  yoloMode(repo: string): boolean;
  /** Whether the hopper merges nothing in this repository (issue #2752): none of the job repositories, and yolo mode not named on for it. Absent: never. */
  needsMerge?(repo: string): boolean;
  /** A repository's landing branch (issue #1143): its landing batch setting (issue #1142), read at each call; undefined: no landing batches. */
  landingBranch?(repo: string): string | undefined;
  /** The change rule of this repository (issue #1076): what kind of change a pull request is, and each kind's merge gate. Read at each call. */
  changeRule(repo: string): ChangeRule;
  /** The artifacts a job made (issue #673): each one's id and the URL of the issue it is linked to. */
  jobArtifacts(jobId: string): { id: string; issue?: string }[];
  /** The pull requests a job opened through the hopper's GitHub proxy (issue #2510), their URLs, the newest first. Absent: none. */
  jobOpenedPullRequests?(jobId: string): string[];
  /** The done criteria of the conditional skills a job got (issue #1924), by skill: what the done check verifies itself. Absent: none. */
  jobDoneCriteria?(jobId: string): { skill: string; done: DoneCriterion[]; paths?: string[] }[];
  /** The deletes a job's issue allows by resource address (issue #1924 part 2), from the text it runs. Absent: none. */
  jobAllowedDeletes?(jobId: string): string[];
  /** Why a delivery hold holds a job's change (issue #2775 part 7): yolo mode does not merge it. Absent or undefined: none. */
  jobDeliveryHold?(jobId: string): string | undefined;
  /** The user's issue graph (issue #437): a source keeps the place of each issue it sees there. Store only. */
  issueGraph: Pick<IssueGraphRepository, 'record' | 'lastRead'>;
  /** The user's listing cache (issue #985): each repository's latest repository listing. Absent: a source keeps it in memory. */
  githubListings?: GitHubListingRepository;
  /** The user's GitHub outbox (issue #1238): the GitHub changes people's actions asked for, until sent. Absent: a source keeps it in memory. */
  githubOutbox?: GitHubOutboxRepository;
  /** The user's mirrors of the job repositories (issue #858): whether a pull request has conflicts, as git says. Absent: none. */
  gitMirrors?: GitMirrors;
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
  /**
   * A job source's (issue #1264): whether two instances of this plugin, with these parsed options, take the same work, so a
   * second is refused and one already configured shows as a duplicate. False when either is off. Absent: never.
   */
  sameWork?(a: O, b: O): boolean;
  create(ctx: PluginContext & RoleContext[R], options: O): RoleInstance[R] | Promise<RoleInstance[R]>;
}
