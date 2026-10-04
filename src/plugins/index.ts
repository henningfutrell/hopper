// The plugin host (design.md "Phase 5"): built-in + custom plugins, plugins.yaml watched by mtime,
// detection of every plugin, the live roles (the router — from plugins.yaml, else chosen from what
// is detected — the answerer and the assessor, each swapped between calls) and the restart roles
// (executors, job sources, the machine source, usage sources): built once at start; a later change
// is reported as pending. A section plugins.yaml leaves out means the built-in instances.
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Answerer, Assessor, Clock, MachineSource, UsageSource } from '../domain/ports.ts';
import {
  ROLES, type Detection, type InstanceSpec, type PluginsReport, type RestartRoleStatus, type RouterMode, type RouterSelection, type RouterStatus,
} from '../domain/types.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { optionsJsonSchema, parseOptions } from './options.ts';
import { loadPluginsFile } from './plugins-file.ts';
import { buildExecutors, executorStatus, type BuiltExecutor } from './executor-slot.ts';
import { builtinInstances } from './migrate.ts';
import { NO_MACHINE, buildJobSources, buildMachine, buildUsageSources, instanceStatus, type Built, type BuiltJobSource } from './source-slots.ts';
import { answererStatus, assessorStatus, buildAnswerer, buildAssessor, type BuiltAnswerer, type BuiltAssessor } from './question-slots.ts';
import { buildRouter, createLiveRouter, detectRouter, safeDetect, type BuiltRouter, type LiveRouter, type SlotDeps } from './router-slot.ts';
import type { DetectionKit, JobSourceContext, PluginDefinition, PluginLogger, Router } from './sdk.ts';

export type { BuiltExecutor } from './executor-slot.ts';
export type { Built, BuiltJobSource } from './source-slots.ts';
export type { PluginDefinition } from './sdk.ts';

export interface PluginHostOptions {
  pluginDir: string;
  pluginsFile: string;
  /** The answerer instance when plugins.yaml has no `answerer` section; null = none. Default: the built-in one. */
  defaultAnswerer?: InstanceSpec | null;
  /** The assessor instance when plugins.yaml has no `assessor` section. Default: the built-in one. */
  defaultAssessor?: InstanceSpec;
  /** The executor instances when plugins.yaml has no `executors` section. Default: the built-in ones. */
  defaultExecutors?: InstanceSpec[];
  /** What job sources are told. Default (tests): no key known, nothing re-runnable, no comment helper. */
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
  report(): PluginsReport;
  /** Re-read plugins.yaml now, whatever the mtime; resolves when the router is in place. */
  reload(): Promise<void>;
}

interface Entry { definition: PluginDefinition; builtin: boolean; path?: string; detection: Detection }

/** A restart role: what was built at start, and what plugins.yaml names now when that differs. */
interface RestartSlot<B extends { spec: InstanceSpec }> { built?: B[]; pending?: InstanceSpec[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function restartStatus<B extends { spec: InstanceSpec }>(slot: RestartSlot<B>, status: (b: B) => RestartRoleStatus['instances'][number]): RestartRoleStatus {
  return {
    instances: (slot.built ?? []).map(status),
    ...(slot.pending ? { pending: { status: 'changed — restart pending' as const, instances: slot.pending } } : {}),
  };
}

const NO_SOURCE_CONTEXT: JobSourceContext = { knownKeys: () => new Set(), rerunnable: () => new Set(), commentCmd: '' };

export function createPluginHost(o: PluginHostOptions): PluginHost {
  const kit = o.kit ?? createDetectionKit();
  const builtins = o.builtins ?? BUILTIN_PLUGINS;
  let loaded: LoadResult = { plugins: [], errors: [], warnings: [] };
  let entries: Entry[] = [];
  let live: LiveRouter | undefined;
  let selection: RouterSelection = 'detected';
  let answerer: BuiltAnswerer | undefined;
  let assessor: BuiltAssessor | undefined;
  const builtin = builtinInstances(dirname(o.pluginsFile));
  const defaults = {
    answerer: o.defaultAnswerer === undefined ? builtin.answerer : o.defaultAnswerer,
    assessor: o.defaultAssessor ?? builtin.assessor,
    executors: o.defaultExecutors ?? builtin.executors,
    jobSources: builtin.jobSources,
    machines: builtin.machines,
    usageSources: builtin.usageSources,
  };
  const executors: RestartSlot<BuiltExecutor> = {};
  const jobSources: RestartSlot<BuiltJobSource> = {};
  const machines: RestartSlot<Built<MachineSource>> = {};
  const usageSources: RestartSlot<Built<UsageSource>> = {};
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const config: PluginsReport['config'] = { path: o.pluginsFile, source: 'defaults', warnings: [] };

  const find = (id: string): PluginDefinition | undefined => entries.find((e) => e.definition.id === id)?.definition;
  const runnableExecutors = () => (executors.built ?? []).flatMap((b) => (b.executor ? [b.executor.name] : []));
  const deps: SlotDeps = {
    kit, clock: o.clock, logger: o.logger, dataDir: o.dataDir, routerMode: o.routerMode, find,
    jobSource: o.jobSourceContext ?? NO_SOURCE_CONTEXT, executors: o.machineContext?.executors ?? runnableExecutors,
  };

  /** Build a restart role once; afterwards only record whether plugins.yaml now names something else. */
  async function restart<B extends { spec: InstanceSpec }>(slot: RestartSlot<B>, label: string, specs: InstanceSpec[], build: () => Promise<B[]>): Promise<void> {
    if (!slot.built) {
      slot.built = await build();
      return;
    }
    const changed = !same(slot.built.map((b) => b.spec), specs);
    if (changed && !same(slot.pending, specs)) o.logger.info(`job-hopper: ${label} changed — restart pending`);
    slot.pending = changed ? specs : undefined;
  }
  const sign = (): string => {
    try { const s = statSync(o.pluginsFile); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; }
  };

  async function catalogueDetection(def: PluginDefinition): Promise<Detection> {
    const parsed = parseOptions(def, {});
    if (!parsed.ok) return { status: 'needs-setup', reason: parsed.error, command: `set ${def.role} options for ${def.id} in ${o.pluginsFile}` };
    return safeDetect(def, kit, parsed.options);
  }

  async function configure(): Promise<void> {
    signature = sign();
    const r = loadPluginsFile(o.pluginsFile);
    const file = 'error' in r || 'missing' in r ? undefined : r;
    let spec = {
      router: file?.router,
      answerer: file?.answerer !== undefined ? file.answerer : defaults.answerer,
      assessor: file?.assessor ?? defaults.assessor,
      executors: file?.executors ?? defaults.executors,
      jobSources: file?.jobSources ?? defaults.jobSources,
      machines: file?.machines ?? defaults.machines,
      usageSources: file?.usageSources ?? defaults.usageSources,
    };
    let error = 'error' in r ? r.error : undefined;
    if (!error && spec.answerer && spec.answerer.name === spec.assessor.name) {
      error = `${o.pluginsFile}: answerer and assessor have the same name (${spec.answerer.name}); a question stage must say which one holds it`;
    }
    if (error) {
      config.error = error;
      o.logger.warn(`job-hopper: ${error}`);
      if (live) return; // keep the last good instances
      spec = { router: undefined, ...defaults };
    } else {
      delete config.error;
      config.loadedAt = o.clock.now().toISOString();
    }
    config.source = file && !error ? 'file' : 'defaults';
    config.warnings = 'warnings' in r ? r.warnings : [];
    const next: RouterSelection = spec.router ? 'file' : 'detected';
    const unchanged = (s: InstanceSpec) => live !== undefined && selection === next && same(live.current().spec, s);
    if (!spec.router || !unchanged(spec.router)) {
      // Detection is re-run on every reload, so a router installed since the last one is picked up.
      const built: BuiltRouter = spec.router ? await buildRouter(spec.router, deps) : await detectRouter(entries.map((e) => e.definition), deps);
      if (!unchanged(built.spec)) {
        if (live) live.swap(built);
        else live = createLiveRouter(built, o.clock);
        selection = next;
        o.logger.info(`job-hopper: router ${built.spec.name} (${built.plugin}${built.fallback ? ', fallback' : ''}; ${next})`);
      }
    }
    if (!answerer || !same(answerer.spec, spec.answerer)) {
      answerer = await buildAnswerer(spec.answerer, deps);
      o.logger.info(`job-hopper: answerer ${spec.answerer ? `${spec.answerer.name} (${answerer.plugin ?? 'unavailable'})` : 'none'}`);
    }
    if (!assessor || !same(assessor.spec, spec.assessor)) {
      assessor = await buildAssessor(spec.assessor, deps);
      o.logger.info(`job-hopper: assessor ${spec.assessor.name} (${assessor.plugin}${assessor.fallback ? ', fallback' : ''})`);
    }
    await restart(executors, 'executors', spec.executors, () => buildExecutors(spec.executors, deps));
    await restart(jobSources, 'job sources', spec.jobSources, () => buildJobSources(spec.jobSources, deps));
    await restart(machines, 'machine source', [spec.machines], async () => [await buildMachine(spec.machines, deps)]);
    await restart(usageSources, 'usage sources', spec.usageSources, () => buildUsageSources(spec.usageSources, deps));
  }

  function started<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('plugin host not started');
    return value;
  }

  const enqueue = (): Promise<void> => {
    chain = chain.then(configure, configure).catch((e) => o.logger.warn(`job-hopper: plugins.yaml reload failed: ${String(e)}`));
    return chain;
  };

  const need = (): LiveRouter => {
    if (!live) throw new Error('plugin host not started');
    return live;
  };

  return {
    async start() {
      loaded = await loadCustomPlugins(o.pluginDir, new Set(builtins.map((b) => b.id)));
      for (const e of loaded.errors) o.logger.warn(`job-hopper: plugin ${e.path} refused: ${e.error}`);
      for (const w of loaded.warnings) o.logger.warn(`job-hopper: ${w}`);
      const all: { definition: PluginDefinition; builtin: boolean; path?: string }[] = [
        ...builtins.map((definition) => ({ definition, builtin: true })),
        ...loaded.plugins.map((p: LoadedPlugin) => ({ definition: p.definition, builtin: false, path: p.path })),
      ];
      entries = await Promise.all(all.map(async (e) => ({ ...e, detection: await catalogueDetection(e.definition) })));
      await enqueue();
      timer = setInterval(() => { if (sign() !== signature) void enqueue(); }, o.intervalMs ?? 5000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    get router() { return need().router; },
    routerStatus: () => need().status(),
    answerer: () => answerer?.answerer,
    assessor() {
      if (!assessor) throw new Error('plugin host not started');
      return assessor.assessor;
    },
    executors: () => [...started(executors.built)],
    jobSources: () => [...started(jobSources.built)],
    machines: () => started(machines.built)[0]?.instance ?? NO_MACHINE,
    usageSources: () => started(usageSources.built).flatMap((b) => (b.instance ? [b.instance] : [])),
    reload: enqueue,
    report() {
      const current = need().current();
      const status = need().status();
      return {
        roles: [...ROLES],
        config: { ...config, warnings: [...config.warnings] },
        router: {
          instance: current.spec, selection, detection: current.detection, active: current.plugin, fallback: status.fallback,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        },
        answerer: answerer ? answererStatus(answerer) : { instance: null, active: null, fallback: false },
        assessor: assessor ? assessorStatus(assessor) : { instance: defaults.assessor, active: null, fallback: false },
        executors: restartStatus(executors, executorStatus),
        jobSources: restartStatus(jobSources, instanceStatus),
        machines: restartStatus(machines, instanceStatus),
        usageSources: restartStatus(usageSources, instanceStatus),
        plugins: entries.map((e) => ({
          id: e.definition.id, role: e.definition.role, describe: e.definition.describe, builtin: e.builtin,
          ...(e.path ? { path: e.path } : {}), detection: e.detection, options: optionsJsonSchema(e.definition),
        })),
        errors: [...loaded.errors],
        warnings: [...loaded.warnings],
      };
    },
  };
}
