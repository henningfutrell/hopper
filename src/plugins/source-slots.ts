// The source roles' slots (design.md "Failure", "Settled in slice 4"), all restart roles built
// once at start: job sources (0..n; one that cannot run is dropped with its reason; one whose
// detection says needs-setup still runs, since it can wait for its setup), the machine source (1;
// one that cannot run leaves no machine, so every job is held — never a guessed machine) and usage
// sources (0..n; dropped with the reason). Each is known by its instance name.
import type { MachineSource, UsageSource } from '../domain/ports.ts';
import type { Detection, InstanceSpec, InstanceStatus, Role } from '../domain/types.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';
import type { JobSourceInstance, RoleInstance } from './sdk.ts';

/** One instance of a restart role: running (`instance`, `plugin`), or not (`reason`). */
export type Built<T> = { spec: InstanceSpec; detection: Detection } & (
  | { instance: T; plugin: string; reason?: undefined }
  | { instance?: undefined; plugin: null; reason: string }
);

export type BuiltJobSource = Built<JobSourceInstance>;

export async function buildOne<R extends Role>(role: R, spec: InstanceSpec, deps: SlotDeps, o: { needsSetupRuns?: boolean; check?: (i: RoleInstance[R]) => string | undefined } = {}): Promise<Built<RoleInstance[R]>> {
  const built = await instantiate(role, spec, deps, o.needsSetupRuns);
  const why = built.ok ? o.check?.(built.instance) : built.why;
  if (built.ok && why === undefined) return { spec, instance: built.instance, plugin: built.plugin, detection: built.detection };
  deps.logger.warn(`hopper: ${role} ${spec.name} (${spec.plugin}) unavailable: ${why}`);
  return { spec, detection: built.detection, plugin: null, reason: why! };
}

/** A source that names itself otherwise would key its jobs under a name no sync slot has. */
const namedAsInstance = (spec: InstanceSpec) => (i: JobSourceInstance): string | undefined =>
  ('source' in i && i.source.name !== spec.name ? `the source calls itself ${i.source.name}, not ${spec.name}; it must use ctx.instanceName` : undefined);

export function buildJobSources(specs: InstanceSpec[], deps: SlotDeps): Promise<BuiltJobSource[]> {
  return Promise.all(specs.map((spec) => buildOne('job-source', spec, deps, { needsSetupRuns: true, check: namedAsInstance(spec) })));
}

export function buildMachine(spec: InstanceSpec, deps: SlotDeps): Promise<Built<MachineSource>> {
  return buildOne('machine-source', spec, deps);
}

/**
 * The machine source as plugins.yaml names it now (issue #18): the same instance with other options
 * (its lane count) is rebuilt at once; another name or plugin waits for a restart (`pending`), since
 * lanes are stored under the machine id.
 */
export async function applyMachineSpec(slot: { built?: Built<MachineSource>[]; pending?: InstanceSpec[] }, spec: InstanceSpec, deps: SlotDeps): Promise<void> {
  const now = slot.built?.[0];
  if (now && (now.spec.name !== spec.name || now.spec.plugin !== spec.plugin)) {
    if (!slot.pending) deps.logger.info('hopper: machine source changed — restart pending');
    slot.pending = [spec];
    return;
  }
  slot.pending = undefined;
  if (now && JSON.stringify(now.spec) === JSON.stringify(spec)) return;
  slot.built = [await buildMachine(spec, deps)];
  if (now) deps.logger.info(`hopper: machine source ${spec.name} options applied`);
}

/** No machine: every job is held (`no online machine runs executor …`). */
export const NO_MACHINE: MachineSource = { list: async () => [] };

export async function buildUsageSources(specs: InstanceSpec[], deps: SlotDeps): Promise<Built<UsageSource>[]> {
  const built = await Promise.all(specs.map((spec) => buildOne('usage-source', spec, deps)));
  // The instance name wins over the plugin's own; every other member is the plugin's.
  return built.map((b) => (b.instance ? { ...b, instance: Object.create(b.instance, { name: { value: b.spec.name, enumerable: true } }) as UsageSource } : b));
}

export function instanceStatus<T>(b: Built<T>): InstanceStatus {
  return b.instance !== undefined
    ? { instance: b.spec, detection: b.detection, active: b.plugin }
    : { instance: b.spec, detection: b.detection, active: null, reason: b.reason };
}
