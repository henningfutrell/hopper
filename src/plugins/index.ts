// The plugin host (design.md "Phase 5"): built-in + custom plugins, plugins.yaml watched by version,
// detection of every plugin, the live roles (the router — from plugins.yaml, else chosen from what
// is detected — the queue sorter and the escalation levels, each swapped between calls) and the restart roles
// (executors, job sources, usage sources, notifiers): built once at start; a later change is
// reported as pending. The machine sources — this machine and the attached ones, each an instance
// (issue #74) — follow plugins.yaml live (issue #18). Notifiers are started with the event feed by the caller. A section plugins.yaml leaves out means the built-in instances.
// UI edits (edit.ts, attached-edit.ts) replace plugins.yaml in the store and apply like any other change.
import type { MachineSource, Notifier, UsageSource } from '../domain/ports.ts';
import {
  ROLES, type AttachedMachine, type ConfiguredInstance, type Detection, type InstanceSpec, type PluginsReport, type RestartRoleStatus, type RouterSelection, type RoutingRule,
} from '../domain/types.ts';
import { createMachinesEditor } from './attached-slot.ts';
import { createRoutingConfig } from './routing-config.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { optionsJsonSchema, parseOptions } from './options.ts';
import { applyEdit, configuredInstances, type Configured } from './edit.ts';
import { BY_HAND, PLUGINS, loadPluginsFile } from './plugins-file.ts';
import { buildExecutors, executorStatus, type BuiltExecutor } from './executor-slot.ts';
import { builtinInstances } from './builtin-instances.ts';
import { buildNotifiers, startNotifiers, stopNotifiers } from './notifier-slot.ts';
import { applyMachineSpecs, buildJobSources, buildUsageSources, instanceStatus, type Built, type BuiltJobSource } from './source-slots.ts';
import { targetOf } from './machine-source/targets.ts';
import { createTargetPool } from '../machines/index.ts';
import { buildQueueSorter, createLiveQueueSorter, type LiveQueueSorter } from './queue-sorter-slot.ts';
import { buildLevel, levelStatus, type BuiltLevel } from './level-slot.ts';
import { buildRouter, createLiveRouter, detectRouter, safeDetect, type BuiltRouter, type LiveRouter, type SlotDeps } from './router-slot.ts';
import type { JobSourceContext, PluginDefinition } from './sdk.ts';
import type { PluginHost, PluginHostOptions } from './host-types.ts';

export type { PluginHost, PluginHostOptions } from './host-types.ts';

export type { BuiltExecutor } from './executor-slot.ts';
export type { Built, BuiltJobSource } from './source-slots.ts';
export type { PluginDefinition } from './sdk.ts';



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

const NO_SOURCE_CONTEXT: JobSourceContext = { knownKeys: () => new Set(), rerunnable: () => new Set() };

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
    queueSorter: builtin.queueSorter,
    escalationLevels: o.defaultLevels ?? builtin.escalationLevels,
    executors: o.defaultExecutors ?? builtin.executors,
    jobSources: builtin.jobSources,
    machines: builtin.machines,
    usageSources: builtin.usageSources,
    notifiers: builtin.notifiers,
  };
  const executors: RestartSlot<BuiltExecutor> = {};
  const jobSources: RestartSlot<BuiltJobSource> = {};
  const machines: { built?: Built<MachineSource>[] } = {};
  const usageSources: RestartSlot<Built<UsageSource>> = {};
  const notifiers: RestartSlot<Built<Notifier>> = {};
  let notifiersStarted = false;
  let notifiersStopped: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** What plugins.yaml (or the built-in instances) names now: the last good configuration. */
  let configured: Configured | undefined;
  const config: Omit<PluginsReport['config'], 'version'> = { document: PLUGINS, source: 'defaults', warnings: [] };

  const find = (id: string): PluginDefinition | undefined => entries.find((e) => e.definition.id === id)?.definition;
  const runnableExecutors = () => (executors.built ?? []).flatMap((b) => (b.executor ? [b.executor.name] : []));
  const deps: SlotDeps = {
    kit, clock: o.clock, logger: o.logger, dataDir: o.dataDir, routerMode: o.routerMode, find,
    jobSource: o.jobSourceContext ?? NO_SOURCE_CONTEXT, executors: o.machineContext?.executors ?? runnableExecutors,
    target: o.machineContext?.target ?? createTargetPool({ probe: async () => ({ online: false }) }),
    machine: async (id) => (await liveMachines.list()).find((m) => m.id === id),
  };

  /** Build a restart role once; afterwards only record whether plugins.yaml now names something else. */
  async function restart<B extends { spec: InstanceSpec }>(slot: RestartSlot<B>, label: string, specs: InstanceSpec[], build: () => Promise<B[]>): Promise<void> {
    if (!slot.built) {
      slot.built = await build();
      return;
    }
    const changed = !same(slot.built.map((b) => b.spec), specs);
    if (changed && !same(slot.pending, specs)) o.logger.info(`hopper: ${label} changed — restart pending`);
    slot.pending = changed ? specs : undefined;
  }
  const sign = (): string => o.documents.version(PLUGINS);

  async function catalogueDetection(def: PluginDefinition): Promise<Detection> {
    const parsed = parseOptions(def, {});
    if (!parsed.ok) return { status: 'needs-setup', reason: parsed.error, command: `set ${def.role} options for ${def.id}: ${BY_HAND}` };
    return safeDetect(def, kit, parsed.options);
  }

  async function configure(): Promise<void> {
    signature = sign();
    const r = loadPluginsFile(o.documents.read(PLUGINS));
    const file = 'error' in r || 'missing' in r ? undefined : r;
    let spec = {
      router: file?.router,
      routing: file?.routing ?? defaults.routing,
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
    config.source = file && !error ? 'document' : 'defaults';
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
    await restart(executors, 'executors', spec.executors, () => buildExecutors(spec.executors, deps));
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
    chain = chain.then(configure, configure).catch((e) => o.logger.warn(`hopper: plugins.yaml reload failed: ${String(e)}`));
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
    entries = await Promise.all(all.map(async (e) => ({ ...e, detection: await catalogueDetection(e.definition) })));
  }

  const fileVersion = (): string => o.documents.version(PLUGINS);

  const instances = (): ConfiguredInstance[] => (configured ? configuredInstances(configured, need().current().spec) : []);

  const need = (): LiveRouter => {
    if (!live) throw new Error('plugin host not started');
    return live;
  };

  const machinesEditor = createMachinesEditor({
    ...o.attached, documents: o.documents, dataDir: o.dataDir, logger: o.logger,
    configured: () => started(configured), version: fileVersion, error: () => config.error, reload: enqueue,
  });
  const machineIds = (): string[] => (machines.built ?? []).flatMap((b) => (b.instance ? [b.spec.name] : []));
  const routingConfig = createRoutingConfig({
    documents: o.documents,
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
        // Act on what the document says now, not on a reload the watch timer has not run yet.
        if (sign() !== signature) await enqueue();
        const r = applyEdit(e, {
          documents: o.documents, configured: instances(), find: (id) => entries.find((x) => x.definition.id === id), inUse: o.attached?.inUse ?? (() => []),
        });
        if (!r.ok) return r;
        if (r.changed) {
          o.logger.info(`hopper: plugins.yaml edited in the UI: ${e.action} ${e.role} ${e.action === 'select' ? String(e.plugin) : e.name}`);
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
        executors: restartStatus(executors, executorStatus),
        jobSources: restartStatus(jobSources, instanceStatus),
        machines: { instances: (machines.built ?? []).map(instanceStatus) },
        usageSources: restartStatus(usageSources, instanceStatus),
        notifiers: restartStatus(notifiers, instanceStatus),
        plugins: entries.map((e) => ({
          id: e.definition.id, role: e.definition.role, describe: e.definition.describe, builtin: e.builtin,
          ...(e.path ? { path: e.path } : {}), detection: e.detection, options: optionsJsonSchema(e.definition),
        })),
        errors: [...loaded.errors],
        warnings: [...loaded.warnings],
      };
    },
  };
  return host;
}
