// Building a role's instance (resolve → options → detect → create; `instantiate`, shared by every
// role), and the router role's one slot: fall back to pass-through when it cannot run, and answer
// through a live Router whose instance can be swapped between calls (design.md "Failure").
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Advice, Detection, InstanceSpec, RouterStatus } from '../domain/types.ts';
import { parseOptions } from './options.ts';
import passThrough from './router/pass-through/index.ts';
import type { Clock, DetectionKit, PluginContext, PluginDefinition, Role, RoleContext, RoleInstance, Router, RouterMode } from './sdk.ts';

export interface SlotDeps {
  kit: DetectionKit;
  clock: Clock;
  logger: PluginContext['logger'];
  dataDir: string;
  routerMode(): RouterMode;
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

/** The context `create` gets: base fields plus every role's own (the router's mode). */
function contextFor(deps: SlotDeps, id: string) {
  const scratchDir = join(deps.dataDir, 'plugin-data', id);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  return { clock: deps.clock, logger: deps.logger, dataDir: deps.dataDir, scratchDir, routerMode: deps.routerMode };
}

/** Resolve → options → detect → create, for any role. Never throws. */
export async function instantiate<R extends Role>(role: R, spec: InstanceSpec, deps: SlotDeps): Promise<Instantiated<R>> {
  const def = deps.find(spec.plugin);
  if (!def || def.role !== role) {
    const why = `unknown ${role} plugin ${spec.plugin}`;
    return { ok: false, why, detection: { status: 'unavailable', reason: why } };
  }
  const parsed = parseOptions(def, spec.options);
  if (!parsed.ok) return { ok: false, why: parsed.error, detection: { status: 'unavailable', reason: parsed.error } };
  const detection = await safeDetect(def, deps.kit, parsed.options);
  if (detection.status !== 'available') return { ok: false, why: reasonOf(detection), detection };
  try {
    const instance = await (def as PluginDefinition<R>).create(contextFor(deps, def.id) as PluginContext & RoleContext[R], parsed.options);
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
  const inner = await passThrough.create(contextFor(deps, passThrough.id), {});
  const router: Router = {
    name: spec.name,
    async advise(job): Promise<Advice> {
      return { ...(await inner.advise(job)), source: 'fallback', reason: `router ${spec.name} unavailable: ${why}` };
    },
  };
  return { spec, router, plugin: passThrough.id, detection: built.detection, fallback: why };
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
