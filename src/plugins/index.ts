// The plugin host (design.md "Phase 5"): built-in + custom plugins, the plugins config watched by version,
// detection of every plugin and the option choices it lists. Every role follows the plugins config live:
// the router — from the plugins config, else chosen from what is detected — the queue sorter and the
// escalation levels, each swapped between calls; the machine sources — this machine and the attached ones,
// each an instance (issue #74, live since issue #18); the executors (issue #142: a shipped plugin is enabled
// in the UI and runs at once); and the job sources, usage sources and notifiers (issue #356: no restart
// role is left), and the vault backends (issue #585). An unchanged instance is kept, a new or changed one built, a removed one retired.
// Notifiers are started with the event feed by the caller; one built later starts with that feed. A
// section the plugins config leaves out means the built-in instances.
// UI edits (edit.ts, attached-edit.ts) replace the plugins config in the store and apply like any other change.
import type { MachineSource, Notifier, NotifierEvents, UsageSource } from '../domain/ports.ts';
import type { VaultBackend } from '../domain/vault.ts';
import {
  ROLES, type AttachedMachine, type ConfiguredInstance, type Detection, type InstanceSpec, type InstanceStatus, type MachineSnapshot, type OptionChoice, type PluginsReport, type RouterSelection, type RoutingRule,
} from '../domain/types.ts';
import { withMachineNote as withNote } from '../domain/machine-pick.ts';
import { createMachinesEditor } from './attached-slot.ts';
import { createRoutingConfig } from './routing-config.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { machineOptions, optionsJsonSchema, parseOptions, withMachineChoices } from './options.ts';
import { applyEdit, configuredInstances, describeEdit, type Configured } from './edit.ts';
import { PLUGINS, loadPluginsConfig } from './plugins-config.ts';
import { applyExecutorSpecs, executorStatus, type BuiltExecutor } from './executor-slot.ts';
import { builtinInstances } from './builtin-instances.ts';
import { buildNotifier, notifierStatus, runNotifierAction, startNotifier, stopNotifiers } from './notifier-slot.ts';
import { NO_SOURCE_CONTEXT, applyJobSourceSpecs, applyMachineSpecs, applyUsageSpecs, applyVaultBackendSpecs, configuredBackend, followSpecs, instanceStatus, type Built, type BuiltJobSource } from './source-slots.ts';
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);


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
  // A vault backend is always optional (issue #585): none unless the plugins config names one. Never written to a fresh
  // store's plugins config either, so a build from before vault backends still reads it.
  const defaults = {
    ...builtin, routing: [] as RoutingRule[], machineDefaults: {}, vaultBackends: [] as InstanceSpec[],
    escalationLevels: o.defaultLevels ?? builtin.escalationLevels, executors: o.defaultExecutors ?? builtin.executors, machines: o.defaultMachines ?? builtin.machines,
  };
  const executors: { built?: BuiltExecutor[] } = {};
  const jobSources: { built?: BuiltJobSource[] } = {};
  const machines: { built?: Built<MachineSource>[] } = {};
  const usageSources: { built?: Built<UsageSource>[] } = {};
  const notifiers: { built?: Built<Notifier>[] } = {};
  const vaultBackends: { built?: Built<VaultBackend>[] } = {};
  /** The event feed the notifiers run with, from startNotifiers until stopNotifiers. */
  let feed: NotifierEvents | undefined;
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
    machines: () => liveMachines.list(), escalationMachine: () => configured?.escalationMachine,
    client: o.executorContext?.client ?? (() => undefined),
  };

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
      vaultBackends: file?.vaultBackends ?? defaults.vaultBackends,
      ...(file?.escalationMachine ? { escalationMachine: file.escalationMachine } : {}),
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
    await applyJobSourceSpecs(jobSources, spec.jobSources, deps, o.jobSourcesChanged);
    await applyMachineSpecs(machines, spec.machines, deps);
    await applyUsageSpecs(usageSources, spec.usageSources, deps);
    await followSpecs(notifiers, spec.notifiers, {
      label: 'notifier', logger: o.logger,
      build: async (s) => {
        const b = await buildNotifier(s, deps);
        return feed ? startNotifier(b, feed, o.logger) : b;
      },
      retire: (gone) => (feed ? stopNotifiers(gone, o.logger) : undefined),
    });
    await applyVaultBackendSpecs(vaultBackends, spec.vaultBackends, deps);
  }

  /** The machines as last listed (the engine lists them every tick): whether a level's machine is online, for Settings (issue #482). */
  let lastListed: MachineSnapshot[] | undefined;
  const liveMachines: MachineSource = { list: async () => (lastListed = (await Promise.all((machines.built ?? []).map((b) => b.instance?.list() ?? []))).flat()) };
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
  /** A part that runs claude (issues #442, #482): which machine it runs on, that it needs one, or that its machine cannot run it now, in plain words. */
  const withMachineNote = (st: InstanceStatus): InstanceStatus => withNote(st, configured?.machines ?? [], configured?.escalationMachine, lastListed);

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
    vaultBackends: () => (vaultBackends.built ?? []).map(configuredBackend),
    startNotifiers(events) {
      if (notifiersStarted) return;
      notifiersStarted = true;
      feed = events;
      notifiers.built = started(notifiers.built).map((b) => startNotifier(b, events, o.logger));
    },
    stopNotifiers() {
      if (!notifiersStarted) return Promise.resolve();
      feed = undefined;
      notifiersStopped ??= stopNotifiers(started(notifiers.built), o.logger);
      return notifiersStopped;
    },
    targets,
    machinesConfig: () => machinesEditor.config(), editMachines: (e) => machinesEditor.edit(e),
    machineHostKey: (ssh) => machinesEditor.hostKey(ssh), editMachineDefaults: (e) => machinesEditor.editDefaults(e), joinMachine: (j) => machinesEditor.joinMachine(j),
    reload: enqueue,
    routingRules: () => [...(configured?.routing ?? [])],
    machineIds,
    routing: routingConfig.report,
    editRouting: routingConfig.edit,
    notifierAction: (name, action) => runNotifierAction(host.notifiers(), name, action),
    async edit(e) {
      if (e.action === 'rescan') {
        await scan();
        await enqueue();
        o.logger.info('hopper: plugins rescanned');
      } else {
        // Act on what the config says now, not on a reload the watch timer has not run yet.
        if (sign() !== signature) await enqueue();
        const r = applyEdit(e, {
          config: o.config, configured: instances(), escalationMachine: configured?.escalationMachine, find: (id) => entries.find((x) => x.definition.id === id), inUse: (role, name) => (role === 'machine-source' ? o.attached?.inUse?.(name) ?? [] : role === 'executor' ? o.executorInUse?.(name) ?? [] : []), pinned: (name) => o.attached?.pinned?.(name) ?? [],
        });
        if (!r.ok) return r;
        if (r.changed) {
          o.logger.info(`hopper: plugins config edited in the UI: ${describeEdit(e)}`);
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
        escalationLevels: started(levels).map((l) => withMachineNote(levelStatus(l))),
        ...(configured?.escalationMachine ? { escalationMachine: configured.escalationMachine } : {}),
        executors: { instances: (executors.built ?? []).map(executorStatus) },
        jobSources: { instances: (jobSources.built ?? []).map(instanceStatus) },
        machines: { instances: (machines.built ?? []).map(instanceStatus) },
        usageSources: { instances: (usageSources.built ?? []).map((b) => withMachineNote(instanceStatus(b))) },
        notifiers: { instances: (notifiers.built ?? []).map(notifierStatus) },
        vaultBackends: { instances: (vaultBackends.built ?? []).map(instanceStatus) },
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
