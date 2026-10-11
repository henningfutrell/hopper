// Launching a sandbox box (issue #708): a template and its parameters → a record, a volume, a container, started.
// The record is written before the container is made, so a container of the hopper's never exists without one but
// while a launch makes it; a launch that fails leaves nothing it made — the container, a volume it made new, the
// record. A home volume that was there already (a box of that name before it, kept) stays.
import { checkWait } from '../domain/read-only-check.ts';
import type { BoxTool, ContainerRuntime, LaunchParams, SandboxRecord } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import type { TemplateView } from '../domain/vault.ts';
import { isRootUser } from './flags.ts';
import { resolveParams } from './params.ts';
import { toolsImage } from './tools.ts';

/** The label on every box the hopper launches: its value is the hopper's instance id. */
export const BOX_LABEL = 'io.hopper.box';
/** The label naming the user whose box it is. */
export const USER_LABEL = 'io.hopper.user';
/** The published image a box of an agent runs: its `box-<agent>` tag. */
export const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper';

/** A launch the hopper refuses before it starts anything: 400 for parameters, 409 for a template not approved. */
export class LaunchRefused extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LaunchRequest { agent: string; template?: TemplateView; params: LaunchParams }

export interface LaunchContext {
  runtime: ContainerRuntime;
  repo: SandboxRepository;
  instanceId: string;
  network: string;
  joinUrl: string;
  now: Date;
  id: string;
  /** A join code for the user's box `container`, of `template` when it is one's. */
  mint(container: string, template: string | undefined): string;
  /** Launches in flight, by record id: the reconcile pass leaves them. */
  launching: Set<string>;
}

/** The image a box runs, and its user: `base`, with `tools` added when it names any (issue #716), built once per base and set of tools. */
export async function boxImage(runtime: ContainerRuntime, base: string, tools: readonly BoxTool[] | undefined): Promise<{ image: string; user: string }> {
  const read = await runtime.pull(base);
  if (isRootUser(read.user)) throw new Error(`the image ${base} runs as root: a sandbox box runs as a non-root user (USER in its image)`);
  if (!tools?.length) return { image: base, user: read.user };
  const built = toolsImage({ image: base, id: read.id }, tools);
  await runtime.build(built.tag, built.containerfile);
  return { image: built.tag, user: (await runtime.pull(built.tag)).user };
}

const profileKey = (p: { operation: string; asset: { kind: string; name: string } }): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;

export async function launchBox(c: LaunchContext, userId: string, l: LaunchRequest): Promise<SandboxRecord> {
  const t = l.template;
  if (t && (t.approval === undefined || t.pending.image)) throw new LaunchRefused(409, `the image of template ${t.name} is not approved: approve it in Settings → Vault first`);
  // The read-only check (issue #716): a template that needs one starts no box until its current version passed.
  const waits = t && checkWait(t);
  if (waits) throw new LaunchRefused(409, waits);
  const resolved = resolveParams(t && { name: t.name, gives: t.gives, profiles: t.profiles.map(profileKey), limits: t.limits, tools: t.tools }, l.params);
  if (!resolved.ok) throw new LaunchRefused(400, resolved.error);
  const { params } = resolved;

  const { image, user } = await boxImage(c.runtime, t?.image ?? `${BOX_IMAGE}:box-${l.agent}`, params.tools);

  const stem = `hopper-sandbox-${t?.name ?? l.agent}`;
  const taken = new Set([...(await c.runtime.list()).map((x) => x.name), ...c.repo.list().map((r) => r.name)]);
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  const record: SandboxRecord = {
    id: c.id, userId, name, agent: l.agent, ...(t ? { template: { name: t.name, version: t.savedAt } } : {}), image, params,
    runtime: c.runtime.kind, machine: 'local', containerId: '', volume: `${name}-home`, keepHome: t?.limits?.keepHome ?? true,
    state: 'starting', createdAt: c.now.toISOString(),
    ...(params.ttlMinutes !== undefined ? { expiresAt: new Date(c.now.getTime() + params.ttlMinutes * 60_000).toISOString() } : {}),
    address: c.joinUrl,
  };
  if (!c.repo.add(record)) throw new Error(`a sandbox box named ${name} was launched meanwhile: start it again`);
  c.launching.add(record.id);
  let madeVolume = false;
  try {
    const labels = { [BOX_LABEL]: c.instanceId, [USER_LABEL]: userId };
    const code = c.mint(name, t?.name);
    madeVolume = await c.runtime.createVolume(record.volume, labels);
    record.containerId = await c.runtime.create({
      name, image, network: c.network, volume: record.volume, labels, user,
      env: { HOPPER_CLIENT_NAME: name, HOPPER_JOIN: `${c.joinUrl}#${code}` },
      limits: { cpus: params.cpus, memoryMb: params.memoryMb },
    });
    c.repo.update(record);
    await c.runtime.start(record.containerId);
    return record;
  } catch (e) {
    // Only by the id it made: a create that failed (a name taken meanwhile) made nothing, and the name may be another's.
    if (record.containerId) await c.runtime.remove(record.containerId).catch(() => {});
    if (madeVolume) await c.runtime.removeVolume(record.volume).catch(() => {});
    c.repo.remove(record.id);
    throw e;
  } finally {
    c.launching.delete(record.id);
  }
}
