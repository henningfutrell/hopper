// Building a role's instance (resolve → options → detect → create; `instantiate`, shared by every
// role), and the router role's one slot: the router named in plugins.yaml (pass-through standing in
// when it cannot run), else the first router that can run here; answered through a live Router
// whose instance can be swapped between calls (design.md "Failure", "Router selection").
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Advice, Detection, InstanceSpec, RouterStatus } from '../domain/types.ts';
import { parseOptions } from './options.ts';
import passThrough from './router/pass-through/index.ts';
import type {
  Clock, DetectionKit, JobSourceContext, PluginContext, PluginDefinition, Role, RoleContext, RoleInstance, Router, RouterMode,
} from './sdk.ts';

export interface SlotDeps {
  kit: DetectionKit;
  clock: Clock;
  logger: PluginContext['logger'];
  dataDir: string;
  routerMode(): RouterMode;
  /** What a job source is told (RoleContext['job-source']). */
  jobSource: JobSourceContext;
  /** The executors a machine source names (RoleContext['machine-source']). */
  executors(): string[];
  find(id: string): PluginDefinition | undefined;
}

/** One built router instance. `fallback` is set when it is pass-through standing in. */
export interface BuiltRouter {
  spec: InstanceSpec;
  router: Router;
  /** The plugin answering. */
  plugin: string;
  detection: Detection;
  fallback?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** detect() that never throws: a throw is `unavailable`. */
export async function safeDetect(def: PluginDefinition, kit: DetectionKit, options: unknown): Promise<Detection> {
  try {
    return await def.detect(kit, options);
  } catch (e) {
    return { status: 'unavailable', reason: `detect failed: ${message(e)}` };
  }
}

const reasonOf = (d: Detection): string => (d.status === 'available' ? '' : d.status === 'needs-setup' ? `${d.reason} (run: ${d.command})` : d.reason);

/** An instance of one role, or why it cannot run here (with the detection that said so, if any). */
export type Instantiated<R extends Role> =
  | { ok: true; instance: RoleInstance[R]; plugin: string; detection: Detection }
  | { ok: false; why: string; detection: Detection };

/** The context `create` gets: base fields plus every role's own (the router's mode, a job source's store view, …). */
function contextFor(deps: SlotDeps, id: string, instanceName: string) {
  const scratchDir = join(deps.dataDir, 'plugin-data', id);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  return {
    clock: deps.clock, logger: deps.logger, dataDir: deps.dataDir, scratchDir, instanceName, routerMode: deps.routerMode,
    ...deps.jobSource, executors: deps.executors,
  };
}

/**
 * Resolve → options → detect → create, for any role. Never throws. `needsSetupRuns`: a plugin whose
 * detection says needs-setup is still created (a job source that waits for its setup, then works
 * without a restart); the detection is reported as it is.
 */
export async function instantiate<R extends Role>(role: R, spec: InstanceSpec, deps: SlotDeps, needsSetupRuns = false): Promise<Instantiated<R>> {
  const def = deps.find(spec.plugin);
  if (!def || def.role !== role) {
    const why = `unknown ${role} plugin ${spec.plugin}`;
    return { ok: false, why, detection: { status: 'unavailable', reason: why } };
  }
  const parsed = parseOptions(def, spec.options);
  if (!parsed.ok) return { ok: false, why: parsed.error, detection: { status: 'unavailable', reason: parsed.error } };
  const detection = await safeDetect(def, deps.kit, parsed.options);
  if (detection.status === 'unavailable' || (detection.status === 'needs-setup' && !needsSetupRuns)) return { ok: false, why: reasonOf(detection), detection };
  try {
    const instance = await (def as PluginDefinition<R>).create(contextFor(deps, def.id, spec.name) as PluginContext & RoleContext[R], parsed.options);
    return { ok: true, instance, plugin: def.id, detection };
  } catch (e) {
    return { ok: false, why: `cannot create: ${message(e)}`, detection };
  }
}

export async function buildRouter(spec: InstanceSpec, deps: SlotDeps): Promise<BuiltRouter> {
  const built = await instantiate('router', spec, deps);
  if (built.ok) return { spec, router: built.instance, plugin: built.plugin, detection: built.detection };
  const why = built.why;
  deps.logger.warn(`job-hopper: router ${spec.name} (${spec.plugin}) unavailable, using pass-through: ${why}`);
  const inner = await passThrough.create(contextFor(deps, passThrough.id, spec.name), {});
  const router: Router = {
    name: spec.name,
    async advise(job): Promise<Advice> {
      return { ...(await inner.advise(job)), source: 'fallback', reason: `router ${spec.name} unavailable: ${why}` };
    },
  };
  return { spec, router, plugin: passThrough.id, detection: built.detection, fallback: why };
}

/**
 * No router named in plugins.yaml: the first router plugin, in catalogue order, that detects
 * available and starts with its default options. pass-through when none does — chosen, not a
 * fallback.
 */
export async function detectRouter(catalogue: readonly PluginDefinition[], deps: SlotDeps): Promise<BuiltRouter> {
  for (const def of catalogue) {
    if (def.role !== 'router' || def.id === passThrough.id) continue;
    const spec = { name: def.id, plugin: def.id };
    const built = await instantiate('router', spec, deps);
    if (built.ok) return { spec, router: built.instance, plugin: built.plugin, detection: built.detection };
  }
  const spec = { name: passThrough.id, plugin: passThrough.id };
  const router = await passThrough.create(contextFor(deps, passThrough.id, spec.name), {});
  return { spec, router, plugin: passThrough.id, detection: { status: 'available' } };
}

export interface LiveRouter {
  /** Answers through whichever instance is current when the call starts. */
  router: Router;
  current(): BuiltRouter;
  swap(next: BuiltRouter): void;
  status(): RouterStatus;
}

export function createLiveRouter(first: BuiltRouter, clock: Clock): LiveRouter {
  let current = first;
  /** Set while the current instance's last advice was itself a fallback. */
  let adviceFallback: string | undefined;
  const router: Router = {
    get name() { return current.spec.name; },
    async advise(job) {
      const c = current;
      let advice: Advice;
      try {
        advice = await c.router.advise(job);
      } catch (e) {
        advice = { action: 'proceed_full', reason: `router ${c.spec.name} failed: ${message(e)}`, details: {}, source: 'fallback', at: clock.now().toISOString() };
      }
      if (c === current && !c.fallback) adviceFallback = advice.source === 'fallback' ? advice.reason : undefined;
      return advice;
    },
  };
  return {
    router,
    current: () => current,
    swap(next) {
      current = next;
      adviceFallback = undefined;
    },
    status() {
      const { spec, plugin, fallback } = current;
      const reason = fallback ?? adviceFallback;
      return reason === undefined ? { name: spec.name, plugin, fallback: false } : { name: spec.name, plugin, fallback: true, reason };
    },
  };
}
