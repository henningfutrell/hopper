// The plugin host (design.md "Phase 5"): built-in + custom plugins, the plugins config watched by version,
// detection of every plugin and the option choices it lists, the live roles (the router — from the plugins config, else chosen from what
// is detected — the queue sorter and the escalation levels, each swapped between calls) and the restart roles
// (job sources, usage sources, notifiers): built once at start; a later change is reported as pending.
// The machine sources — this machine and the attached ones, each an instance (issue #74) — follow
// the plugins config live (issue #18), and so do the executors (issue #142: a shipped plugin is enabled in the
// UI and runs at once). Notifiers are started with the event feed by the caller. A section the plugins config leaves out means the built-in instances.
// UI edits (edit.ts, attached-edit.ts) replace the plugins config in the store and apply like any other change.
import type { MachineSource, Notifier, UsageSource } from '../domain/ports.ts';
import {
  ROLES, type AttachedMachine, type ConfiguredInstance, type Detection, type InstanceSpec, type OptionChoice, type PluginsReport, type RestartRoleStatus, type RouterSelection, type RoutingRule,
} from '../domain/types.ts';
import { createMachinesEditor } from './attached-slot.ts';
import { createRoutingConfig } from './routing-config.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { machineOptions, optionsJsonSchema, parseOptions, withMachineChoices } from './options.ts';
import { applyEdit, configuredInstances, type Configured } from './edit.ts';
import { PLUGINS, loadPluginsConfig } from './plugins-config.ts';
import { applyExecutorSpecs, executorStatus, type BuiltExecutor } from './executor-slot.ts';
import { builtinInstances } from './builtin-instances.ts';
import { buildNotifiers, startNotifiers, stopNotifiers } from './notifier-slot.ts';
import { NO_SOURCE_CONTEXT, applyMachineSpecs, buildJobSources, buildUsageSources, instanceStatus, type Built, type BuiltJobSource } from './source-slots.ts';
import { targetOf } from './machine-source/targets.ts';
import { createTargetPool } from '../machines/index.ts';
import { buildQueueSorter, createLiveQueueSorter, type LiveQueueSorter } from './queue-sorter-slot.ts';
import { buildLevel, levelStatus, type BuiltLevel } from './level-slot.ts';
import { buildRouter, createLiveRouter, detectRouter, safeDetect, type BuiltRouter, type LiveRouter, type SlotDeps } from './router-slot.ts';
import type { PluginDefinition } from './sdk.ts';
import type { PluginHost, PluginHostOptions } from './host-types.ts';

export type { PluginHost, PluginHostOptions } from './host-types.ts';

export type { BuiltExecutor } from './executor-slot.ts';
export type { Built, BuiltJobSource } from './source-slots.ts';
export type { PluginDefinition } from './sdk.ts';



interface Entry { definition: PluginDefinition; builtin: boolean; path?: string; detection: Detection; choices?: Record<string, OptionChoice[]> }

/** A restart role: what was built at start, and what the plugins config names now when that differs. */
interface RestartSlot<B extends { spec: InstanceSpec }> { built?: B[]; pending?: InstanceSpec[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function restartStatus<B extends { spec: InstanceSpec }>(slot: RestartSlot<B>, status: (b: B) => RestartRoleStatus['instances'][number]): RestartRoleStatus {
  return {
    instances: (slot.built ?? []).map(status),
    ...(slot.pending ? { pending: { status: 'changed — restart pending' as const, instances: slot.pending } } : {}),
  };
}


export function createPluginHost(o: PluginHostOptions): PluginHost {
  const kit = o.kit ?? createDetectionKit();
  const builtins = o.builtins ?? BUILTIN_PLUGINS;
  let loaded: LoadResult = { plugins: [], errors: [], warnings: [] };
  let entries: Entry[] = [];
  let live: LiveRouter | undefined;
  let selection: RouterSelection = 'detected';
  let sorter: LiveQueueSorter | undefined;
  let levels: BuiltLevel[] | undefined;
  const builtin = builtinInstances();
  const defaults = {
    routing: [] as RoutingRule[],
    machineDefaults: {},
    queueSorter: builtin.queueSorter,
    escalationLevels: o.defaultLevels ?? builtin.escalationLevels,
    executors: o.defaultExecutors ?? builtin.executors,
    jobSources: builtin.jobSources,
    machines: o.defaultMachines ?? builtin.machines,
    usageSources: builtin.usageSources,
    notifiers: builtin.notifiers,
  };
  const executors: { built?: BuiltExecutor[] } = {};
  const jobSources: RestartSlot<BuiltJobSource> = {};
  const machines: { built?: Built<MachineSource>[] } = {};
  const usageSources: RestartSlot<Built<UsageSource>> = {};
  const notifiers: RestartSlot<Built<Notifier>> = {};
  let notifiersStarted = false;
  let notifiersStopped: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** What the plugins config (or the built-in instances) names now: the last good configuration. */
  let configured: Configured | undefined;
  const config: Omit<PluginsReport['config'], 'version'> = { source: 'defaults', warnings: [] };

  const find = (id: string): PluginDefinition | undefined => entries.find((e) => e.definition.id === id)?.definition;
  const runnableExecutors = () => (executors.built ?? []).flatMap((b) => (b.executor ? [b.executor.name] : []));
  const deps: SlotDeps = {
    kit, clock: o.clock, logger: o.logger, dataDir: o.dataDir, userEnv: o.userEnv ?? {}, find,
    jobSource: o.jobSourceContext ?? NO_SOURCE_CONTEXT, executors: o.machineContext?.executors ?? runnableExecutors,
    target: o.machineContext?.target ?? createTargetPool({ probe: async () => ({ online: false }) }),
    machine: async (id) => (await liveMachines.list()).find((m) => m.id === id),
  };

  /** Build a restart role once; afterwards only record whether the plugins config now names something else. */
  async function restart<B extends { spec: InstanceSpec }>(slot: RestartSlot<B>, label: string, specs: InstanceSpec[], build: () => Promise<B[]>): Promise<void> {
    if (!slot.built) {
      slot.built = await build();
      return;
    }
    const changed = !same(slot.built.map((b) => b.spec), specs);
    if (changed && !same(slot.pending, specs)) o.logger.info(`hopper: ${label} changed — restart pending`);
    slot.pending = changed ? specs : undefined;
  }
  const sign = (): string => o.config.version(PLUGINS);

  async function catalogueDetection(def: PluginDefinition): Promise<Detection> {
    // A machine option has no default (issue #174): each instance names its machine, so the plugin is
    // detected by what it needs besides the machine.
    const onMachine = machineOptions(def);
    const parsed = parseOptions(def, Object.fromEntries(onMachine.map((k) => [k, '-'])));
    if (!parsed.ok) return { status: 'needs-setup', reason: parsed.error, command: `set the options of a ${def.role} instance of ${def.id} in Plugins` };
    if (onMachine.length) return { status: 'available', detail: 'runs on the machine each instance names' };
    return safeDetect(def, kit, parsed.options);
  }

  /** A plugin's option choices; none when it lists none, or listing throws. */
  async function choicesOf(def: PluginDefinition): Promise<Record<string, OptionChoice[]> | undefined> {
    if (!def.choices) return undefined;
    try {
      const listed = Object.entries(await def.choices(kit)).filter(([, c]) => Array.isArray(c) && c.length > 0);
      return listed.length ? Object.fromEntries(listed) : undefined;
    } catch (e) {
      o.logger.warn(`hopper: plugin ${def.id} could not list its option choices: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  async function configure(): Promise<void> {
    signature = sign();
    const r = loadPluginsConfig(o.config.read(PLUGINS));
    const file = 'error' in r || 'missing' in r ? undefined : r;
    let spec = {
      router: file?.router,
      routing: file?.routing ?? defaults.routing,
      machineDefaults: file?.machineDefaults ?? defaults.machineDefaults,
      queueSorter: file?.queueSorter ?? defaults.queueSorter,
      escalationLevels: file?.escalationLevels ?? defaults.escalationLevels,
      executors: file?.executors ?? defaults.executors,
      jobSources: file?.jobSources ?? defaults.jobSources,
      machines: file?.machines ?? defaults.machines,
      usageSources: file?.usageSources ?? defaults.usageSources,
      notifiers: file?.notifiers ?? defaults.notifiers,
    };
    const error = 'error' in r ? r.error : undefined;
    if (error) {
      config.error = error;
      o.logger.warn(`hopper: ${error}`);
      if (live) return; // keep the last good instances
      spec = { router: undefined, ...defaults };
    } else {
      delete config.error;
      config.loadedAt = o.clock.now().toISOString();
    }
    configured = spec;
    config.source = file && !error ? 'stored' : 'defaults';
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
        o.logger.info(`hopper: router ${built.spec.name} (${built.plugin}${built.fallback ? ', fallback' : ''}; ${next})`);
      }
    }
    if (!sorter || !same(sorter.current().spec, spec.queueSorter)) {
      const built = await buildQueueSorter(spec.queueSorter, deps);
      if (sorter) sorter.swap(built);
      else sorter = createLiveQueueSorter(built, o.logger);
      o.logger.info(`hopper: queue sorter ${spec.queueSorter.name} (${built.plugin}${built.fallback ? ', fallback' : ''})`);
    }
    if (!levels || !same(levels.map((l) => l.spec), spec.escalationLevels)) {
      levels = await Promise.all(spec.escalationLevels.map((s) => buildLevel(s, deps)));
      const names = levels.map((l) => `${l.spec.name} (${l.plugin ?? 'unavailable'})`);
      o.logger.info(`hopper: escalation levels ${names.length ? names.join(' → ') : 'none'} → owner`);
    }
    await applyExecutorSpecs(executors, spec.executors, deps);
    await restart(jobSources, 'job sources', spec.jobSources, () => buildJobSources(spec.jobSources, deps));
    await applyMachineSpecs(machines, spec.machines, deps);
    await restart(usageSources, 'usage sources', spec.usageSources, () => buildUsageSources(spec.usageSources, deps));
    await restart(notifiers, 'notifiers', spec.notifiers, () => buildNotifiers(spec.notifiers, deps));
  }

  const liveMachines: MachineSource = {
    list: async () => (await Promise.all((machines.built ?? []).map((b) => b.instance?.list() ?? []))).flat(),
  };
  /** The attached machines the configured instances name, those whose options are valid. */
  const targets = (): AttachedMachine[] => (configured?.machines ?? []).flatMap((spec) => {
    try { return targetOf(spec) ?? []; } catch { return []; }
  });

  function started<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('plugin host not started');
    return value;
  }

  const enqueue = (): Promise<void> => {
    chain = chain.then(configure, configure).catch((e) => o.logger.warn(`hopper: plugins config reload failed: ${String(e)}`));
    return chain;
  };

  async function scan(): Promise<void> {
    loaded = await loadCustomPlugins([o.pluginDir, o.installedDir].filter((d) => d !== undefined), new Set(builtins.map((b) => b.id)));
    for (const e of loaded.errors) o.logger.warn(`hopper: plugin ${e.path} refused: ${e.error}`);
    for (const w of loaded.warnings) o.logger.warn(`hopper: ${w}`);
    const all: { definition: PluginDefinition; builtin: boolean; path?: string }[] = [
      ...builtins.map((definition) => ({ definition, builtin: true })),
      ...loaded.plugins.map((p: LoadedPlugin) => ({ definition: p.definition, builtin: false, path: p.path })),
    ];
    entries = await Promise.all(all.map(async (e) => {
      const [detection, choices] = await Promise.all([catalogueDetection(e.definition), choicesOf(e.definition)]);
      return { ...e, detection, ...(choices ? { choices } : {}) };
    }));
  }

  const fileVersion = (): string => o.config.version(PLUGINS);

  const instances = (): ConfiguredInstance[] => (configured ? configuredInstances(configured, need().current().spec) : []);

  const need = (): LiveRouter => {
    if (!live) throw new Error('plugin host not started');
    return live;
  };

  const machinesEditor = createMachinesEditor({
    ...o.attached, config: o.config, dataDir: o.dataDir, logger: o.logger,
    configured: () => started(configured), version: fileVersion, error: () => config.error, reload: enqueue,
    machineOptionsOf: (id) => { const def = find(id); return def ? machineOptions(def) : []; },
  });
  const machineIds = (): string[] => (machines.built ?? []).flatMap((b) => (b.instance ? [b.spec.name] : []));
  const routingConfig = createRoutingConfig({
    config: o.config,
    rules: () => configured?.routing ?? [],
    running: () => ({ machines: machineIds(), executors: (executors.built ?? []).map((b) => b.spec.name) }),
    configured: () => ({
      machines: (configured?.machines ?? []).map((m) => m.name),
      executors: (configured?.executors ?? []).map((e) => e.name),
    }),
    version: fileVersion,
    error: () => config.error,
    reload: enqueue,
  });

  const host: PluginHost = {
    async start() {
      await scan();
      await enqueue();
      timer = setInterval(() => { if (sign() !== signature) void enqueue(); }, o.intervalMs ?? 5000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const b of usageSources.built ?? []) b.instance?.stop?.();
    },
    get router() { return need().router; },
    routerStatus: () => need().status(),
    get queueSorter() { return started(sorter).sorter; },
    levels: () => started(levels).map((l) => l.level),
    executors: () => [...started(executors.built)],
    jobSources: () => [...started(jobSources.built)],
    machines: () => { started(machines.built); return liveMachines; },
    usageSources: () => started(usageSources.built).flatMap((b) => (b.instance ? [b.instance] : [])),
    notifiers: () => started(notifiers.built).flatMap((b) => (b.instance ? [b.instance] : [])),
    startNotifiers(events) {
      if (notifiersStarted) return;
      notifiersStarted = true;
      startNotifiers(started(notifiers.built), events, o.logger);
    },
    stopNotifiers() {
      if (!notifiersStarted) return Promise.resolve();
      notifiersStopped ??= stopNotifiers(started(notifiers.built), o.logger);
      return notifiersStopped;
    },
    targets,
    machinesConfig: () => machinesEditor.config(),
    editMachines: (e) => machinesEditor.edit(e),
    editMachineDefaults: (e) => machinesEditor.editDefaults(e),
    reload: enqueue,
    routingRules: () => [...(configured?.routing ?? [])],
    machineIds,
    routing: routingConfig.report,
    editRouting: routingConfig.edit,
    async edit(e) {
      if (e.action === 'rescan') {
        await scan();
        await enqueue();
        o.logger.info('hopper: plugins rescanned');
      } else {
        // Act on what the config says now, not on a reload the watch timer has not run yet.
        if (sign() !== signature) await enqueue();
        const r = applyEdit(e, {
          config: o.config, configured: instances(), find: (id) => entries.find((x) => x.definition.id === id), inUse: (role, name) => (role === 'machine-source' ? o.attached?.inUse?.(name) ?? [] : role === 'executor' ? o.executorInUse?.(name) ?? [] : []), pinned: (name) => o.attached?.pinned?.(name) ?? [],
        });
        if (!r.ok) return r;
        if (r.changed) {
          o.logger.info(`hopper: plugins config edited in the UI: ${e.action} ${e.role} ${e.action === 'select' ? String(e.plugin) : e.name}${e.action === 'options' && e.rename && e.rename !== e.name ? ` renamed ${e.rename}` : ''}`);
          await enqueue();
        }
      }
      return { ok: true, report: host.report() };
    },
    report() {
      const current = need().current();
      const status = need().status();
      return {
        roles: [...ROLES],
        config: { ...config, version: fileVersion(), warnings: [...config.warnings] },
        instances: instances(),
        router: {
          instance: current.spec, selection, detection: current.detection, active: current.plugin, fallback: status.fallback,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        },
        queueSorter: started(sorter).status(),
        escalationLevels: started(levels).map(levelStatus),
        executors: { instances: (executors.built ?? []).map(executorStatus) },
        jobSources: restartStatus(jobSources, instanceStatus),
        machines: { instances: (machines.built ?? []).map(instanceStatus) },
        usageSources: restartStatus(usageSources, instanceStatus),
        notifiers: restartStatus(notifiers, instanceStatus),
        plugins: entries.map((e) => ({
          id: e.definition.id, role: e.definition.role, describe: e.definition.describe, builtin: e.builtin,
          ...(e.path ? { path: e.path } : {}), detection: e.detection, options: optionsJsonSchema(e.definition),
          ...withMachineChoices(e.definition, e.choices, configured?.machines ?? []),
        })),
        errors: [...loaded.errors],
        warnings: [...loaded.warnings],
      };
    },
  };
  return host;
}
