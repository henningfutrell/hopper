// The plugin host (design.md "Phase 5"): built-in + custom plugins, plugins.yaml (router, answerer,
// assessor, executors sections) watched by mtime, detection of every plugin, the live roles (the
// router, the answerer and the assessor, each swapped between calls) and the executors, a restart
// role: built once at start; a later change is reported as pending.
import { statSync } from 'node:fs';
import type { Answerer, Assessor, Clock } from '../domain/ports.ts';
import { ROLES, type Detection, type InstanceSpec, type PluginsReport, type RouterMode, type RouterStatus } from '../domain/types.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { optionsJsonSchema, parseOptions } from './options.ts';
import { loadPluginsFile } from './plugins-file.ts';
import { buildExecutors, executorStatus, type BuiltExecutor } from './executor-slot.ts';
import { answererStatus, assessorStatus, buildAnswerer, buildAssessor, type BuiltAnswerer, type BuiltAssessor } from './question-slots.ts';
import { buildRouter, createLiveRouter, safeDetect, type LiveRouter, type SlotDeps } from './router-slot.ts';
import type { DetectionKit, PluginDefinition, PluginLogger, Router } from './sdk.ts';

export type { BuiltExecutor } from './executor-slot.ts';
export type { PluginDefinition } from './sdk.ts';

export interface PluginHostOptions {
  pluginDir: string;
  pluginsFile: string;
  /** The router instance when plugins.yaml names none (derived from the env). */
  defaultRouter: InstanceSpec;
  /** The answerer instance when plugins.yaml has no `answerer` section; null = none. */
  defaultAnswerer: InstanceSpec | null;
  /** The assessor instance when plugins.yaml has no `assessor` section. */
  defaultAssessor: InstanceSpec;
  /** The executor instances when plugins.yaml has no `executors` section. */
  defaultExecutors: InstanceSpec[];
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
  /** Live: swaps between calls when plugins.yaml changes. Valid after start(). */
  readonly router: Router;
  routerStatus(): RouterStatus;
  /** The answerer now, or undefined (none configured, or it cannot run). Valid after start(). */
  answerer(): Answerer | undefined;
  /** The assessor now (always-escalate standing in when the configured one cannot run). Valid after start(). */
  assessor(): Assessor;
  /** The executor instances built at start, runnable or not. Fixed until restart. Valid after start(). */
  executors(): BuiltExecutor[];
  report(): PluginsReport;
  /** Re-read plugins.yaml now, whatever the mtime; resolves when the router is in place. */
  reload(): Promise<void>;
}

interface Entry { definition: PluginDefinition; builtin: boolean; path?: string; detection: Detection }

export function createPluginHost(o: PluginHostOptions): PluginHost {
  const kit = o.kit ?? createDetectionKit();
  const builtins = o.builtins ?? BUILTIN_PLUGINS;
  let loaded: LoadResult = { plugins: [], errors: [], warnings: [] };
  let entries: Entry[] = [];
  let live: LiveRouter | undefined;
  let answerer: BuiltAnswerer | undefined;
  let assessor: BuiltAssessor | undefined;
  let executors: BuiltExecutor[] | undefined;
  /** What plugins.yaml (or the env) names now, when it differs from the executors running. */
  let pendingExecutors: InstanceSpec[] | undefined;
  let timer: NodeJS.Timeout | undefined;
  let signature: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const config: PluginsReport['config'] = { path: o.pluginsFile, source: 'env', warnings: [] };

  const find = (id: string): PluginDefinition | undefined => entries.find((e) => e.definition.id === id)?.definition;
  const deps: SlotDeps = { kit, clock: o.clock, logger: o.logger, dataDir: o.dataDir, routerMode: o.routerMode, find };
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
      router: file?.router ?? o.defaultRouter,
      answerer: file?.answerer !== undefined ? file.answerer : o.defaultAnswerer,
      assessor: file?.assessor ?? o.defaultAssessor,
      executors: file?.executors ?? o.defaultExecutors,
    };
    let error = 'error' in r ? r.error : undefined;
    if (!error && spec.answerer && spec.answerer.name === spec.assessor.name) {
      error = `${o.pluginsFile}: answerer and assessor have the same name (${spec.answerer.name}); a question stage must say which one holds it`;
    }
    if (error) {
      config.error = error;
      o.logger.warn(`job-hopper: ${error}`);
      if (live) return; // keep the last good instances
      spec = { router: o.defaultRouter, answerer: o.defaultAnswerer, assessor: o.defaultAssessor, executors: o.defaultExecutors };
    } else {
      delete config.error;
      config.loadedAt = o.clock.now().toISOString();
    }
    config.source = file && !error ? 'file' : 'env';
    config.warnings = 'warnings' in r ? r.warnings : [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!live || !same(live.current().spec, spec.router)) {
      const built = await buildRouter(spec.router, deps);
      if (live) live.swap(built);
      else live = createLiveRouter(built, o.clock);
      o.logger.info(`job-hopper: router ${spec.router.name} (${built.plugin}${built.fallback ? ', fallback' : ''})`);
    }
    if (!answerer || !same(answerer.spec, spec.answerer)) {
      answerer = await buildAnswerer(spec.answerer, deps);
      o.logger.info(`job-hopper: answerer ${spec.answerer ? `${spec.answerer.name} (${answerer.plugin ?? 'unavailable'})` : 'none'}`);
    }
    if (!assessor || !same(assessor.spec, spec.assessor)) {
      assessor = await buildAssessor(spec.assessor, deps);
      o.logger.info(`job-hopper: assessor ${spec.assessor.name} (${assessor.plugin}${assessor.fallback ? ', fallback' : ''})`);
    }
    if (!executors) {
      executors = await buildExecutors(spec.executors, deps);
    } else {
      const running = executors.map((e) => e.spec);
      const changed = !same(running, spec.executors);
      if (changed && !same(pendingExecutors, spec.executors)) o.logger.info('job-hopper: executors changed — restart pending');
      pendingExecutors = changed ? spec.executors : undefined;
    }
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
    executors() {
      if (!executors) throw new Error('plugin host not started');
      return [...executors];
    },
    reload: enqueue,
    report() {
      const current = need().current();
      const status = need().status();
      return {
        roles: [...ROLES],
        config: { ...config, warnings: [...config.warnings] },
        router: {
          instance: current.spec, detection: current.detection, active: current.plugin, fallback: status.fallback,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        },
        answerer: answerer ? answererStatus(answerer) : { instance: null, active: null, fallback: false },
        assessor: assessor ? assessorStatus(assessor) : { instance: o.defaultAssessor, active: null, fallback: false },
        executors: {
          instances: (executors ?? []).map(executorStatus),
          ...(pendingExecutors ? { pending: { status: 'changed — restart pending' as const, instances: pendingExecutors } } : {}),
        },
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
