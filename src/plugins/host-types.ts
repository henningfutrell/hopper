// The plugin host's contract (index.ts builds it): what it is given, and what it offers the
// composition root and the HTTP edge.
import type { ConfigDocuments } from '../domain/ports.ts';
import type { Clock, EscalationLevel, MachineSource, Notifier, NotifierEvents, UsageSource } from '../domain/ports.ts';
import type {
  AttachedMachine, InstanceSpec, MachineEdit, MachineEditOutcome, MachinesConfig, PluginsEdit, PluginsEditOutcome, PluginsReport, RouterMode, RouterStatus, RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule,
} from '../domain/types.ts';
import type { AttachedEditOptions } from './attached-slot.ts';
import type { BuiltExecutor } from './executor-slot.ts';
import type { BuiltJobSource } from './source-slots.ts';
import type { DetectionKit, JobSourceContext, MachineSourceContext, PluginDefinition, PluginLogger, QueueSorter, Router } from './sdk.ts';

export interface PluginHostOptions {
  /** Custom plugins, one directory each; undefined: none (design.md "Where plugins live"). */
  pluginDir?: string;
  /** Store installs, unpacked into the work dir (the plugin store's `installedDir`); undefined: none. */
  installedDir?: string;
  /** Where plugins.yaml is kept: the store's config documents. */
  documents: ConfigDocuments;
  /** The escalation levels when plugins.yaml has no `escalationLevels` section. Default: the built-in ones. */
  defaultLevels?: InstanceSpec[];
  /** The executor instances when plugins.yaml has no `executors` section. Default: the built-in ones. */
  defaultExecutors?: InstanceSpec[];
  /** What job sources are told. Default (tests): no key known, nothing re-runnable. */
  jobSourceContext?: JobSourceContext;
  /**
   * What the machine sources are told. Default executors: the runnable ones this host built. Default
   * target: the attached machine, never probed, so offline.
   */
  machineContext?: Partial<MachineSourceContext>;
  dataDir: string;
  clock: Clock;
  logger: PluginLogger;
  routerMode(): RouterMode;
  /** Default: the real kit. */
  kit?: DetectionKit;
  /** Default: BUILTIN_PLUGINS. */
  builtins?: readonly PluginDefinition[];
  /** How often plugins.yaml's version is checked; default 5000. */
  intervalMs?: number;
  /** What attaching a machine, or removing one, needs (issues #18, #74). */
  attached?: AttachedEditOptions;
}

export interface PluginHost {
  /** Load plugins, read plugins.yaml, build the router, detect every plugin, start the watch. */
  start(): Promise<void>;
  /** Stop the plugins.yaml watch and every usage source's background work. */
  stop(): void;
  /** Live: swaps between calls when plugins.yaml changes. Valid after start(). With no router in plugins.yaml, the first router that can run here. */
  readonly router: Router;
  routerStatus(): RouterStatus;
  /** Live: the queue-sorter instance now (priority answering for one that cannot run or misbehaves). Valid after start(). */
  readonly queueSorter: QueueSorter;
  /** The escalation levels now, lowest first; one that cannot run escalates every question it gets. Valid after start(). */
  levels(): EscalationLevel[];
  /** The executor instances built at start, runnable or not. Fixed until restart. Valid after start(). */
  executors(): BuiltExecutor[];
  /** The job source instances built at start, running, disabled or not. Fixed until restart. Valid after start(). */
  jobSources(): BuiltJobSource[];
  /** Every machine of every machine source, in plugins.yaml order; follows plugins.yaml live. One that cannot run lists none. Valid after start(). */
  machines(): MachineSource;
  /** The usage sources built at start that run. Valid after start(). */
  usageSources(): UsageSource[];
  /** The notifiers built at start that run (and, once started, did not throw). Valid after start(). */
  notifiers(): Notifier[];
  /** Start every notifier with the event feed; one whose start throws is dropped with its reason. Once. */
  startNotifiers(events: NotifierEvents): void;
  /** Stop every started notifier, awaiting in-flight work. Once; never throws. */
  stopNotifiers(): Promise<void>;
  /** The attached machines the machine-source instances name now, those whose options are valid (design.md "Attached machines", issue #74). */
  targets(): AttachedMachine[];
  /** GET /api/machines/config. Valid after start(). */
  machinesConfig(): MachinesConfig;
  /** POST /ui/api/machines: attach an ssh target; resolves once plugins.yaml is reloaded. */
  editMachines(e: MachineEdit): Promise<MachineEditOutcome>;
  report(): PluginsReport;
  /** plugins.yaml `routing:` now (none when absent; the last good list on an invalid file). */
  routingRules(): RoutingRule[];
  /** The machine ids running now (every machine-source instance that runs): what intake routes to. */
  machineIds(): string[];
  /** GET /api/routing. */
  routing(): RoutingReport;
  /** POST /ui/api/routing: the whole list; applied (re-read) before it resolves. */
  editRouting(e: RoutingEdit): Promise<RoutingEditOutcome>;
  /** Re-read plugins.yaml now, whatever the mtime; resolves when the router is in place. */
  reload(): Promise<void>;
  /** A UI edit of plugins.yaml, or a rescan; resolves once the change is in place. */
  edit(e: PluginsEdit): Promise<PluginsEditOutcome>;
}
