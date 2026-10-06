// The executor role's slots (design.md "Failure"): 1..n instances, following the plugins config live (issue
// #142): an unchanged instance is kept, a new or changed one built, a removed one dropped. An instance that cannot run (unknown plugin, invalid options, not detected, create threw)
// has no executor and a reason: the engine holds the jobs naming it. The instance is named after
// the plugins config whatever the plugin calls itself: jobs name the instance (`spec.executor`).
import type { Executor } from '../domain/ports.ts';
import type { Detection, InstanceStatus, ExecutorUnavailable, InstanceSpec } from '../domain/types.ts';
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
    deps.logger.warn(`hopper: executor ${spec.name} (${spec.plugin}) unavailable, its jobs are held: ${built.why}`);
    return { spec, detection: built.detection, plugin: null, reason: built.why };
  }));
}

/** Follow the plugins config: keep each unchanged instance (same spec), build the others; log what changed after the first build. */
export async function applyExecutorSpecs(slot: { built?: BuiltExecutor[] }, specs: InstanceSpec[], deps: SlotDeps): Promise<void> {
  const before = slot.built;
  const same = (b: BuiltExecutor, spec: InstanceSpec) => JSON.stringify(b.spec) === JSON.stringify(spec);
  const kept = (spec: InstanceSpec) => before?.find((b) => same(b, spec));
  const fresh = await buildExecutors(specs.filter((s) => !kept(s)), deps);
  slot.built = specs.map((spec) => kept(spec) ?? fresh.find((b) => b.spec === spec)!);
  if (!before) return;
  for (const b of fresh) deps.logger.info(`hopper: executor ${b.spec.name} (${b.spec.plugin}) applied`);
  for (const b of before) if (!specs.some((s) => s.name === b.spec.name)) deps.logger.info(`hopper: executor ${b.spec.name} removed`);
}

export function executorStatus(b: BuiltExecutor): InstanceStatus {
  return b.executor ? { instance: b.spec, detection: b.detection, active: b.plugin } : { instance: b.spec, detection: b.detection, active: null, reason: b.reason };
}

export function unavailableExecutors(built: BuiltExecutor[]): ExecutorUnavailable[] {
  return built.flatMap((b) => (b.executor ? [] : [{ name: b.spec.name, reason: b.reason }]));
}
