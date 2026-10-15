// Launching a sandbox box (issue #708): a template and its parameters → a record, a volume, a container, started.
// The record is written before the container is made, so a container of the hopper's never exists without one but
// while a launch makes it; a launch that fails leaves nothing it made — the container, a volume it made new, the
// record. A home volume that was there already (a box of that name before it, kept) stays. Each box carries its
// record's id as a label, so a create whose answer was lost (a machine's link that dropped mid-call) finds the box it
// made instead of leaving it behind: create is idempotent by the sandbox id.
import { checkWait } from '../domain/read-only-check.ts';
import type { BoxTool, ContainerRuntime, LaunchParams, SandboxRecord, StartCheck } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';
import type { TemplateView } from '../domain/vault.ts';
import { isRootUser, runFlags } from './flags.ts';
import { resolveParams, type LaunchTemplate } from './params.ts';
import { toolsImage } from './tools.ts';
import { launchCredential } from './agent-credential.ts';
import type { AgentCredentialAnswer, AgentCredentialAsk } from '../vault/agent-credential.ts';

/** The label on every box the hopper launches: its value is the hopper's instance id. */
export const BOX_LABEL = 'io.hopper.box';
/** The label naming the user whose box it is. */
export const USER_LABEL = 'io.hopper.user';
/** The label naming the sandbox record of the box: its id. */
export const SANDBOX_LABEL = 'io.hopper.sandbox';
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

/** `machine`: the client target it starts on; absent, the computer the hopper runs on. */
export interface LaunchRequest { agent: string; template?: TemplateView; params: LaunchParams; machine?: string }

export interface LaunchContext {
  runtime: ContainerRuntime;
  repo: SandboxRepository;
  instanceId: string;
  /** Where it runs: `local`, or a client target's name. */
  machine: string;
  network: string;
  joinUrl: string;
  now: Date;
  id: string;
  /** A join code for the user's box `container`, of `template` when it is one's. */
  mint(container: string, template: string | undefined): string;
  /** Launches in flight, by record id: the reconcile pass leaves them. */
  launching: Set<string>;
  /** How long the launch waits for the box's start check to pass. */
  startCheckMs: number;
  /** The user's vault, for the template's agent credential (issue #708, part 10). Absent: no box gets one. */
  agentCredential?: (ask: AgentCredentialAsk) => Promise<AgentCredentialAnswer>;
}

/** The record's note of a start check, at `at`. */
export const checkNote = (r: StartCheck, at: Date): NonNullable<SandboxRecord['check']> => ({ passed: r.passed, at: at.toISOString(), ...(r.output ? { output: r.output } : {}) });

/**
 * Runs the box's start check until it passes (issue #708): the box reports that it reaches the hopper at its address
 * before the launch answers. Throws with what the check wrote when it has not passed in `startCheckMs`.
 */
async function startChecked(c: LaunchContext, record: SandboxRecord): Promise<StartCheck | undefined> {
  const end = Date.now() + c.startCheckMs;
  for (;;) {
    const r = await c.runtime.startCheck(record.containerId);
    if (!r || r.passed) return r;
    if (Date.now() >= end) throw new Error(`from inside the box ${record.name}, the hopper does not answer at ${record.address}: ${r.output}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The tools image CI publishes for a box image (issue #1286, .github/workflows/image.yml `box-tools`): the box image with
 * every box tool added as tools.ts adds them, its tag the box image's with `-tools`, or `-tools-read-only` for a
 * read-only template's boxes. A runtime that builds nothing (Kubernetes) runs it. Throws LaunchRefused (409) for an image
 * the hopper does not publish.
 */
export function publishedToolsImage(base: string, readOnly?: boolean): string {
  if (!base.startsWith(`${BOX_IMAGE}:box-`) || base.includes('@')) {
    throw new LaunchRefused(409, `the image ${base} has no published tools image, and this container runtime builds no image: a box with tools runs a hopper box image (${BOX_IMAGE}:box-<agent>) here`);
  }
  return `${base}${readOnly ? '-tools-read-only' : '-tools'}`;
}

/**
 * The image a box runs, and its user: `base`, with `tools` added when it names any (issue #716), built once per base and
 * set of tools — or, on a runtime that builds nothing, the published tools image, which has every tool (issue #1286).
 * `readOnly`: a read-only template's box, whose terraform runs through the read-only wrapper (issue #715).
 */
export async function boxImage(runtime: ContainerRuntime, base: string, tools: readonly BoxTool[] | undefined, readOnly?: boolean): Promise<{ image: string; user: string }> {
  const read = await runtime.pull(base);
  if (isRootUser(read.user)) throw new Error(`the image ${base} runs as root: a sandbox box runs as a non-root user (USER in its image)`);
  if (!tools?.length) return { image: base, user: read.user };
  if (!runtime.build) {
    const image = publishedToolsImage(base, readOnly);
    return { image, user: (await runtime.pull(image)).user };
  }
  const built = toolsImage({ image: base, id: read.id }, tools, { readOnly });
  await runtime.build(built.tag, built.containerfile);
  return { image: built.tag, user: (await runtime.pull(built.tag)).user };
}

const profileKey = (p: { operation: string; asset: { kind: string; name: string } }): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
const launchTemplate = (t: TemplateView): LaunchTemplate => ({ name: t.name, gives: t.gives, profiles: t.profiles.map(profileKey), limits: t.limits, tools: t.tools });

/**
 * The `run` flags of the line Add machine shows for a box the hopper does not start (issue #708): the boxes' own
 * builder, with the CPUs and memory asked for, each within the template's limits (the hopper's for a box of no template).
 */
export function lineFlags(t: TemplateView | undefined, p: Pick<LaunchParams, 'cpus' | 'memoryMb'>): { ok: true; flags: string } | { ok: false; error: string } {
  const resolved = resolveParams(t && launchTemplate(t), p);
  return resolved.ok ? { ok: true, flags: runFlags(resolved.params).join(' ') } : resolved;
}

export async function launchBox(c: LaunchContext, userId: string, l: LaunchRequest): Promise<SandboxRecord> {
  const t = l.template;
  if (t && (t.approval === undefined || t.pending.image)) throw new LaunchRefused(409, `the image of template ${t.name} is not approved: approve it on Access requests first`);
  // The read-only check (issue #716): a template that needs one starts no box until its current version passed.
  const waits = t && checkWait(t);
  if (waits) throw new LaunchRefused(409, waits);
  const resolved = resolveParams(t && launchTemplate(t), l.params);
  if (!resolved.ok) throw new LaunchRefused(400, resolved.error);
  const { params } = resolved;

  const { image, user } = await boxImage(c.runtime, t?.image ?? `${BOX_IMAGE}:box-${l.agent}`, params.tools, t?.readOnly);

  const stem = `hopper-sandbox-${t?.name ?? l.agent}`;
  const taken = new Set([...(await c.runtime.list()).map((x) => x.name), ...c.repo.list().map((r) => r.name)]);
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  // Asked before anything of the box is made: a refusal leaves no record, volume or container.
  const credential = await launchCredential(c.agentCredential, t && { template: t.name, secrets: params.secrets, box: name }, (reason) => new LaunchRefused(409, reason));
  const record: SandboxRecord = {
    id: c.id, userId, name, agent: l.agent, ...(t ? { template: { name: t.name, version: t.savedAt } } : {}), image, params,
    runtime: c.runtime.kind, machine: c.machine, containerId: '', volume: `${name}-home`, keepHome: t?.limits?.keepHome ?? true,
    state: 'starting', createdAt: c.now.toISOString(),
    ...(params.ttlMinutes !== undefined ? { expiresAt: new Date(c.now.getTime() + params.ttlMinutes * 60_000).toISOString() } : {}),
    address: c.joinUrl, ...(credential.name ? { agentCredential: credential.name } : {}),
  };
  if (!c.repo.add(record)) throw new Error(`a sandbox box named ${name} was launched meanwhile: start it again`);
  c.launching.add(record.id);
  let madeVolume = false;
  try {
    const labels = { [BOX_LABEL]: c.instanceId, [USER_LABEL]: userId, [SANDBOX_LABEL]: record.id };
    const code = c.mint(name, t?.name);
    madeVolume = await c.runtime.createVolume(record.volume, labels);
    const spec = {
      name, image, network: c.network, volume: record.volume, labels, user, check: c.joinUrl,
      env: { HOPPER_CLIENT_NAME: name, HOPPER_JOIN: `${c.joinUrl}#${code}`, ...credential.env },
      limits: { cpus: params.cpus, memoryMb: params.memoryMb },
    };
    record.containerId = await c.runtime.create(spec).catch(async (e: unknown) => {
      const made = (await c.runtime.list({ [SANDBOX_LABEL]: record.id }).catch(() => []))[0];
      if (!made) throw e;
      return made.id;
    });
    c.repo.update(record);
    await c.runtime.start(record.containerId);
    const check = await startChecked(c, record);
    if (check) c.repo.update(Object.assign(record, { check: checkNote(check, c.now) }));
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
