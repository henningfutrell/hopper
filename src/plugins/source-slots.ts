// The source roles' slots (design.md "Failure", "Settled in slice 4"), each following the plugins config
// live (`followSpecs`): job sources (0..n, live since issue #356; one that cannot run is dropped with its
// reason; one whose detection says needs-setup still runs, since it can wait for its setup), usage
// sources (0..n, live since issue #356; dropped with the reason) and machine sources (0..n, issue #74,
// live since issue #18; one that cannot run lists no machine — never a guessed one). Each is known by
// its instance name.
import type { MachineSource, UsageSource } from '../domain/ports.ts';
import type { Detection, InstanceSpec, InstanceStatus, Role } from '../domain/types.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';
import type { JobSourceContext, JobSourceInstance, RoleInstance } from './sdk.ts';

/** A job source's context where the host is given none (tests of the host alone): no jobs, no connected accounts. */
export const NO_SOURCE_CONTEXT: JobSourceContext = {
  knownKeys: () => new Set(), rerunnable: () => new Set(), rejections: () => new Map(),
  intake: () => undefined,
  connectedAccounts: { account: () => undefined, ended: () => undefined, token: () => Promise.reject(new Error('no connected accounts')), renew: () => Promise.reject(new Error('no connected accounts')), endpoints: () => ({ url: '', apiUrl: '' }), jobRepositories: () => [] },
};

/** One instance of a list role: running (`instance`, `plugin`), or not (`reason`). */
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

function buildJobSource(spec: InstanceSpec, deps: SlotDeps): Promise<BuiltJobSource> {
  return buildOne('job-source', spec, deps, { needsSetupRuns: true, check: namedAsInstance(spec) });
}

/**
 * Follow the plugins config (issues #18, #142, #356): keep each unchanged instance (same spec), build the
 * new and changed ones, drop the rest; what is no longer built goes to `retire` (a changed instance's old
 * build too). The first call builds all and logs nothing. True when a later call changed what is built.
 */
export async function followSpecs<B extends { spec: InstanceSpec }>(
  slot: { built?: B[] }, specs: InstanceSpec[],
  o: { label: string; logger: SlotDeps['logger']; build: (spec: InstanceSpec) => Promise<B>; retire?: (gone: B[]) => Promise<void> | void },
): Promise<boolean> {
  const before = slot.built;
  const same = (b: B, spec: InstanceSpec) => JSON.stringify(b.spec) === JSON.stringify(spec);
  const next: B[] = await Promise.all(specs.map((spec) => before?.find((b) => same(b, spec)) ?? o.build(spec)));
  slot.built = next;
  if (!before) return false;
  for (const b of next) if (!before.includes(b)) o.logger.info(`hopper: ${o.label} ${b.spec.name} (${b.spec.plugin}) applied`);
  for (const b of before) if (!specs.some((s) => s.name === b.spec.name)) o.logger.info(`hopper: ${o.label} ${b.spec.name} removed`);
  const gone = before.filter((b) => !next.includes(b));
  if (gone.length) await o.retire?.(gone);
  return gone.length > 0 || next.some((b) => !before.includes(b));
}

/** The machine sources as the plugins config names them now (issues #18, #74): this machine and the attached ones. */
export function applyMachineSpecs(slot: { built?: Built<MachineSource>[] }, specs: InstanceSpec[], deps: SlotDeps): Promise<boolean> {
  return followSpecs(slot, specs, { label: 'machine', logger: deps.logger, build: (spec) => buildOne('machine-source', spec, deps) });
}

/** The job sources as the plugins config names them now (issue #356); `changed` hears of each change after the first build. */
export async function applyJobSourceSpecs(slot: { built?: BuiltJobSource[] }, specs: InstanceSpec[], deps: SlotDeps, changed?: (built: BuiltJobSource[]) => void): Promise<void> {
  if (await followSpecs(slot, specs, { label: 'job source', logger: deps.logger, build: (spec) => buildJobSource(spec, deps) })) changed?.(slot.built!);
}

/** The usage sources as the plugins config names them now (issue #356); one no longer named is stopped. */
export function applyUsageSpecs(slot: { built?: Built<UsageSource>[] }, specs: InstanceSpec[], deps: SlotDeps): Promise<boolean> {
  return followSpecs(slot, specs, {
    label: 'usage source', logger: deps.logger, build: (spec) => buildUsageSource(spec, deps),
    retire: (gone) => { for (const b of gone) b.instance?.stop?.(); },
  });
}

async function buildUsageSource(spec: InstanceSpec, deps: SlotDeps): Promise<Built<UsageSource>> {
  const b = await buildOne('usage-source', spec, deps);
  // The instance name wins over the plugin's own; every other member is the plugin's.
  return b.instance ? { ...b, instance: Object.create(b.instance, { name: { value: b.spec.name, enumerable: true } }) as UsageSource } : b;
}

export function instanceStatus<T>(b: Built<T>): InstanceStatus {
  return b.instance !== undefined
    ? { instance: b.spec, detection: b.detection, active: b.plugin }
    : { instance: b.spec, detection: b.detection, active: null, reason: b.reason };
}
