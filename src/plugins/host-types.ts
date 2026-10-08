// The plugin host's contract (index.ts builds it): what it is given, and what it offers the
// composition root and the HTTP edge.
import type { ConfigRecords } from '../domain/ports.ts';
import type { Clock, EscalationLevel, MachineSource, Notifier, NotifierEvents, UsageSource } from '../domain/ports.ts';
import type {
  AttachedMachine, HostKeyOfferOutcome, NotifierAction, NotifierActionOutcome, InstanceSpec, MachineDefaultsEdit, MachineEdit, MachineEditOutcome, MachinesConfig, PluginsEdit, PluginsEditOutcome, PluginsReport, RouterStatus, RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule,
} from '../domain/types.ts';
import type { MachineJoin } from './attached-edit.ts';
import type { AttachedEditOptions } from './attached-slot.ts';
import type { BuiltExecutor } from './executor-slot.ts';
import type { BuiltJobSource } from './source-slots.ts';
import type { DetectionKit, ExecutorContext, JobSourceContext, MachineSourceContext, PluginDefinition, PluginLogger, QueueSorter, Router } from './sdk.ts';

export interface PluginHostOptions {
  /** Custom plugins, one directory each; undefined: none (design.md "Where plugins live"). */
  pluginDir?: string;
  /** Store installs, unpacked into the work dir (the plugin store's `installedDir`); undefined: none. */
  installedDir?: string;
  /** Where the plugins config is kept: the store's config records. */
  config: ConfigRecords;
  /** The escalation levels when the plugins config has no `escalationLevels` section. Default: the built-in ones. */
  defaultLevels?: InstanceSpec[];
  /** The executor instances when the plugins config has no `executors` section. Default: the built-in ones. */
  defaultExecutors?: InstanceSpec[];
  /** The machine instances when the plugins config has no `machines` section. Default: the built-in ones. */
  defaultMachines?: InstanceSpec[];
  /** What job sources are told. Default (tests): no key known, nothing re-runnable. */
  jobSourceContext?: JobSourceContext;
  /**
   * What the machine sources are told. Default executors: the runnable ones this host built. Default
   * target: the attached machine, never probed, so offline.
   */
  machineContext?: Partial<MachineSourceContext>;
  /** What every executor is told (RoleContext['executor']): a client target's link (issue #308). Default: none is reached. */
  executorContext?: ExecutorContext;
  dataDir: string;
  /** PluginContext.userEnv: what the user's processes add to the daemon's environment; default none. */
  userEnv?: Readonly<Record<string, string>>;
  clock: Clock;
  logger: PluginLogger;
  /** Default: the real kit. */
  kit?: DetectionKit;
  /** Default: BUILTIN_PLUGINS. */
  builtins?: readonly PluginDefinition[];
  /** How often the plugins config's version is checked; default 5000. */
  intervalMs?: number;
  /** Hears of each change of the job sources after start (issue #356): the instances built now, in the plugins config order. */
  jobSourcesChanged?(built: BuiltJobSource[]): void;
  /** Jobs that need executor `name` (not ended): its removal is refused while any do (issue #142). Default: none. */
  executorInUse?(name: string): string[];
  /** What attaching a machine, or removing one, needs (issues #18, #74). */
  attached?: AttachedEditOptions;
}

export interface PluginHost {
  /** Load plugins, read the plugins config, build the router, detect every plugin, start the watch. */
  start(): Promise<void>;
  /** Stop the plugins config watch and every usage source's background work. */
  stop(): void;
  /** Live: swaps between calls when the plugins config changes. Valid after start(). With no router in the plugins config, the first router that can run here. */
  readonly router: Router;
  routerStatus(): RouterStatus;
  /** Live: the queue-sorter instance now (priority answering for one that cannot run or misbehaves). Valid after start(). */
  readonly queueSorter: QueueSorter;
  /** The escalation levels now, lowest first; one that cannot run escalates every question it gets. Valid after start(). */
  levels(): EscalationLevel[];
  /** The executor instances now, runnable or not; follows the plugins config live (issue #142). Valid after start(). */
  executors(): BuiltExecutor[];
  /** The job source instances now, running, disabled or not; follows the plugins config live (issue #356). Valid after start(). */
  jobSources(): BuiltJobSource[];
  /** Every machine of every machine source, in the plugins config order; follows the plugins config live. One that cannot run lists none. Valid after start(). */
  machines(): MachineSource;
  /** The usage sources now that run; follows the plugins config live (issue #356). Valid after start(). */
  usageSources(): UsageSource[];
  /** The notifiers now that run (and, once started, did not throw); follows the plugins config live (issue #356). Valid after start(). */
  notifiers(): Notifier[];
  /** Start every notifier with the event feed; one whose start throws is dropped with its reason. Once; a notifier built later starts with this feed. */
  startNotifiers(events: NotifierEvents): void;
  /** Stop every started notifier, awaiting in-flight work; none is started after. Once; never throws. */
  stopNotifiers(): Promise<void>;
  /** POST /ui/api/notifiers (issue #378): a running notifier's action, by instance name. Never throws. */
  notifierAction(name: string, action: NotifierAction): Promise<NotifierActionOutcome>;
  /** The attached machines the machine-source instances name now, those whose options are valid (design.md "Attached machines", issue #74). */
  targets(): AttachedMachine[];
  /** GET /api/machines/config. Valid after start(). */
  machinesConfig(): Promise<MachinesConfig>;
  /** POST /ui/api/machines: attach an ssh target; resolves once the plugins config is reloaded. */
  editMachines(e: MachineEdit): Promise<MachineEditOutcome>;
  /** POST /ui/api/machines/host-key (issue #293): the host key a new ssh target would be pinned to; nothing written. */
  machineHostKey(ssh: string): Promise<HostKeyOfferOutcome>;
  /** POST /ui/api/machines/defaults (issue #142): the plugins config `machineDefaults:`. */
  editMachineDefaults(e: MachineDefaultsEdit): Promise<MachineEditOutcome>;
  /** POST /client/join (issue #308): a machine joining as a client target; resolves once the plugins config is reloaded. */
  joinMachine(j: MachineJoin): Promise<{ ok: true; machine: string } | { ok: false; error: string }>;
  report(): PluginsReport;
  /** the plugins config `routing:` now (none when absent; the last good list on an invalid config). */
  routingRules(): RoutingRule[];
  /** The machine ids running now (every machine-source instance that runs): what intake routes to. */
  machineIds(): string[];
  /** GET /api/routing. */
  routing(): RoutingReport;
  /** POST /ui/api/routing: the whole list; applied (re-read) before it resolves. */
  editRouting(e: RoutingEdit): Promise<RoutingEditOutcome>;
  /** Re-read the plugins config now, whatever its version; resolves when the router is in place. */
  reload(): Promise<void>;
  /** A UI edit of the plugins config, or a rescan; resolves once the change is in place. */
  edit(e: PluginsEdit): Promise<PluginsEditOutcome>;
}
