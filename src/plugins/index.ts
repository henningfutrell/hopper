// The plugin host (design.md "Phase 5"): built-in + custom plugins, plugins.yaml (router section)
// watched by mtime, detection of every plugin, and the live router.
import { statSync } from 'node:fs';
import type { Clock } from '../domain/ports.ts';
import { ROLES, type Detection, type InstanceSpec, type PluginsReport, type RouterMode, type RouterStatus } from '../domain/types.ts';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { createDetectionKit } from './detect.ts';
import { loadCustomPlugins, type LoadedPlugin, type LoadResult } from './loader.ts';
import { optionsJsonSchema, parseOptions } from './options.ts';
import { loadPluginsFile } from './plugins-file.ts';
import { buildRouter, createLiveRouter, safeDetect, type LiveRouter, type SlotDeps } from './router-slot.ts';
import type { DetectionKit, PluginDefinition, PluginLogger, Router } from './sdk.ts';

export type { PluginDefinition } from './sdk.ts';

export interface PluginHostOptions {
  pluginDir: string;
  pluginsFile: string;
  /** The router instance when plugins.yaml names none (slice 1: derived from the env). */
  defaultRouter: InstanceSpec;
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
    if (!parsed.ok) return { status: 'needs-setup', reason: parsed.error, command: `set router options for ${def.id} in ${o.pluginsFile}` };
    return safeDetect(def, kit, parsed.options);
  }

  async function configure(): Promise<void> {
    signature = sign();
    const r = loadPluginsFile(o.pluginsFile);
    if ('error' in r) {
      config.error = r.error;
      o.logger.warn(`job-hopper: ${r.error}`);
      if (live) return; // keep the last good router
    } else {
      delete config.error;
    }
    const fromFile = 'router' in r && r.router ? r.router : undefined;
    const spec = fromFile ?? o.defaultRouter;
    config.source = fromFile ? 'file' : 'env';
    config.warnings = 'warnings' in r ? r.warnings : [];
    if (!('error' in r)) config.loadedAt = o.clock.now().toISOString();
    if (live && JSON.stringify(live.current().spec) === JSON.stringify(spec)) return;
    const built = await buildRouter(spec, deps);
    if (live) live.swap(built);
    else live = createLiveRouter(built, o.clock);
    o.logger.info(`job-hopper: router ${spec.name} (${built.plugin}${built.fallback ? ', fallback' : ''})`);
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
