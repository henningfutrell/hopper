// The executor role's slots (design.md "Failure"): 1..n instances, built once at start (a restart
// role). An instance that cannot run (unknown plugin, invalid options, not detected, create threw)
// has no executor and a reason: the engine holds the jobs naming it. The instance is named after
// plugins.yaml whatever the plugin calls itself: jobs name the instance (`spec.executor`).
import type { Executor } from '../domain/ports.ts';
import type { Detection, ExecutorInstanceStatus, ExecutorUnavailable, InstanceSpec } from '../domain/types.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';

/** One executor instance: running (`executor`, `plugin`), or not (`reason`). */
export type BuiltExecutor = { spec: InstanceSpec; detection: Detection } & (
  | { executor: Executor; plugin: string; reason?: undefined }
  | { executor?: undefined; plugin: null; reason: string }
);

/** The plugin's executor under the instance's name; every other member is the plugin's own. */
const named = (inner: Executor, name: string): Executor => Object.create(inner, { name: { value: name, enumerable: true } }) as Executor;

export async function buildExecutors(specs: InstanceSpec[], deps: SlotDeps): Promise<BuiltExecutor[]> {
  return Promise.all(specs.map(async (spec): Promise<BuiltExecutor> => {
    const built = await instantiate('executor', spec, deps);
    if (built.ok) return { spec, executor: named(built.instance, spec.name), detection: built.detection, plugin: built.plugin };
    deps.logger.warn(`job-hopper: executor ${spec.name} (${spec.plugin}) unavailable, its jobs are held: ${built.why}`);
    return { spec, detection: built.detection, plugin: null, reason: built.why };
  }));
}

export function executorStatus(b: BuiltExecutor): ExecutorInstanceStatus {
  return b.executor ? { instance: b.spec, detection: b.detection, active: b.plugin } : { instance: b.spec, detection: b.detection, active: null, reason: b.reason };
}

export function unavailableExecutors(built: BuiltExecutor[]): ExecutorUnavailable[] {
  return built.flatMap((b) => (b.executor ? [] : [{ name: b.spec.name, reason: b.reason }]));
}
