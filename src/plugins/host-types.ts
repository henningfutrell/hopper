// The plugin host's contract (index.ts builds it): what it is given, and what it offers the
// composition root and the HTTP edge.
import type { Answerer, Assessor, Clock, MachineSource, Notifier, NotifierEvents, UsageSource } from '../domain/ports.ts';
import type {
  AttachedMachine, InstanceSpec, PluginsEdit, PluginsEditOutcome, PluginsReport, RouterMode, RouterStatus, RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule,
} from '../domain/types.ts';
import type { BuiltExecutor } from './executor-slot.ts';
import type { BuiltJobSource } from './source-slots.ts';
import type { DetectionKit, JobSourceContext, PluginDefinition, PluginLogger, QueueSorter, Router } from './sdk.ts';

export interface PluginHostOptions {
  pluginDir: string;
  pluginsFile: string;
  /** The answerer instance when plugins.yaml has no `answerer` section; null = none. Default: the built-in one. */
  defaultAnswerer?: InstanceSpec | null;
  /** The assessor instance when plugins.yaml has no `assessor` section. Default: the built-in one. */
  defaultAssessor?: InstanceSpec;
  /** The executor instances when plugins.yaml has no `executors` section. Default: the built-in ones. */
  defaultExecutors?: InstanceSpec[];
  /** What job sources are told. Default (tests): no key known, nothing re-runnable. */
  jobSourceContext?: JobSourceContext;
  /** What the machine source is told. Default: the runnable executors this host built. */
  machineContext?: { executors(): string[] };
  dataDir: string;
  clock: Clock;
  logger: PluginLogger;
  routerMode(): RouterMode;
  /** Default: the real kit. */
  kit?: DetectionKit;
  /** Default: BUILTIN_PLUGINS. */
  builtins?: readonly PluginDefinition[];
  /** How often plugins.yaml's mtime is checked; default 5000. */
  intervalMs?: number;
}

export interface PluginHost {
  /** Load plugins, read plugins.yaml, build the router, detect every plugin, start the watch. */
  start(): Promise<void>;
  stop(): void;
  /** Live: swaps between calls when plugins.yaml changes. Valid after start(). With no router in plugins.yaml, the first router that can run here. */
  readonly router: Router;
  routerStatus(): RouterStatus;
  /** Live: the queue-sorter instance now (priority answering for one that cannot run or misbehaves). Valid after start(). */
  readonly queueSorter: QueueSorter;
  /** The answerer now, or undefined (none configured, or it cannot run). Valid after start(). */
  answerer(): Answerer | undefined;
  /** The assessor now (always-escalate standing in when the configured one cannot run). Valid after start(). */
  assessor(): Assessor;
  /** The executor instances built at start, runnable or not. Fixed until restart. Valid after start(). */
  executors(): BuiltExecutor[];
  /** The job source instances built at start, running, disabled or not. Fixed until restart. Valid after start(). */
  jobSources(): BuiltJobSource[];
  /** The machine source built at start (no machine at all when it cannot run). Valid after start(). */
  machines(): MachineSource;
  /** The usage sources built at start that run. Valid after start(). */
  usageSources(): UsageSource[];
  /** The notifiers built at start that run (and, once started, did not throw). Valid after start(). */
  notifiers(): Notifier[];
  /** Start every notifier with the event feed; one whose start throws is dropped with its reason. Once. */
  startNotifiers(events: NotifierEvents): void;
  /** Stop every started notifier, awaiting in-flight work. Once; never throws. */
  stopNotifiers(): Promise<void>;
  /** plugins.yaml `attachedMachines:` as read at start (design.md "Attached machines"). */
  attachedMachines(): AttachedMachine[];
  report(): PluginsReport;
  /** plugins.yaml `routing:` now (none when absent; the last good list on an invalid file). */
  routingRules(): RoutingRule[];
  /** The machine ids running now (the machine source's, when it runs, and the attached machines): what intake routes to. */
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
