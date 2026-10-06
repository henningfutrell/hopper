// The source roles' slots (design.md "Failure", "Settled in slice 4"), all restart roles built
// once at start: job sources (0..n; one that cannot run is dropped with its reason; one whose
// detection says needs-setup still runs, since it can wait for its setup) and usage sources (0..n;
// dropped with the reason). The machine sources (0..n, issue #74) follow the plugins config live; one that
// cannot run lists no machine — never a guessed one. Each is known by its instance name.
import type { MachineSource, UsageSource } from '../domain/ports.ts';
import type { Detection, InstanceSpec, InstanceStatus, Role } from '../domain/types.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';
import type { JobSourceContext, JobSourceInstance, RoleInstance } from './sdk.ts';

/** A job source's context where the host is given none (tests of the host alone): no jobs, no connected accounts. */
export const NO_SOURCE_CONTEXT: JobSourceContext = {
  knownKeys: () => new Set(), rerunnable: () => new Set(),
  connectedAccounts: { account: () => undefined, token: () => Promise.reject(new Error('no connected accounts')), endpoints: () => ({ url: '', apiUrl: '' }) },
};

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

/**
 * The machine sources as the plugins config names them now (issues #18, #74): this machine and the attached
 * ones, followed live. An unchanged instance is kept; a new or changed one is built; a removed one goes.
 */
export async function applyMachineSpecs(slot: { built?: Built<MachineSource>[] }, specs: InstanceSpec[], deps: SlotDeps): Promise<void> {
  const before = slot.built;
  const same = (b: Built<MachineSource>, spec: InstanceSpec) => JSON.stringify(b.spec) === JSON.stringify(spec);
  slot.built = await Promise.all(specs.map((spec) => before?.find((b) => same(b, spec)) ?? buildOne('machine-source', spec, deps)));
  if (!before) return;
  for (const spec of specs) if (!before.some((b) => same(b, spec))) deps.logger.info(`hopper: machine ${spec.name} (${spec.plugin}) applied`);
  for (const b of before) if (!specs.some((s) => s.name === b.spec.name)) deps.logger.info(`hopper: machine ${b.spec.name} removed`);
}


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
