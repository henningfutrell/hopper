// Sandbox boxes the hopper launches (issues #603, #708; design.md "Sandbox boxes the hopper launches"): the container
// runtime port, what a box is created as, the launch parameters a template allows, and the sandbox record.

/** The container runtimes the hopper can drive (issue #708). `remote` is an attached machine's, through its client. */
export const RUNTIME_KINDS = ['podman', 'docker', 'remote'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** A container as the container runtime lists or inspects it. */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  /** The runtime's own word: `created`, `running`, `exited`, … */
  state: string;
}

/** The resources one box may use: CPUs (fractions allowed) and memory, in MiB. */
export interface ResourceLimits { cpus: number; memoryMb: number }

/**
 * What the hopper creates a sandbox box as. Only these vary: the adapter always applies the sandbox flags
 * (`src/sandbox/flags.ts`) — every capability dropped, no new privileges, a read-only root, `/tmp` a tmpfs, the
 * home the volume, a non-root user, the resource limits — and mounts nothing of the computer.
 */
export interface ContainerSpec {
  name: string;
  image: string;
  network: string;
  volume: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  limits: ResourceLimits;
  /** The user it runs as: the image's own, never root (the launch refuses an image that runs as root). */
  user: string;
  /**
   * A one-shot container (issue #716, the read-only check): it runs `sh -c <script>` in place of the image's entrypoint,
   * on a terminal, and is not restarted when it ends. Absent: a box, which runs its image's entrypoint and is restarted.
   */
  script?: string;
}

/** What the hopper reads of an image: the user it runs as (`''`: none set, which is root), and its id when the runtime says. */
export interface ImageInfo { user: string; id?: string }

/**
 * The tools the hopper adds to a box's image (issue #716, item 2): each from its own release, pinned, checked by its
 * SHA-256 (src/sandbox/tools.ts). A template names the ones its boxes get; a launch gets them, or names fewer.
 */
export const BOX_TOOLS = ['aws', 'helm', 'kubectl', 'terraform'] as const;
export type BoxTool = (typeof BOX_TOOLS)[number];

/** Why these tools cannot be added: the first the hopper does not know. Undefined: they can. */
export function toolsProblem(tools: readonly string[]): string | undefined {
  const unknown = tools.find((x) => !(BOX_TOOLS as readonly string[]).includes(x));
  return unknown === undefined ? undefined : `${unknown} is not a tool the hopper adds to a box: it adds ${BOX_TOOLS.join(', ')}`;
}

/** The tools, each once, in the catalog's order. */
export const toolSet = (tools: readonly string[]): BoxTool[] => BOX_TOOLS.filter((x) => tools.includes(x));

/** The container runtime port (issue #708): one per kind, the same calls. The hopper's sandbox module drives it. */
export interface ContainerRuntime {
  readonly kind: RuntimeKind;
  /** Why boxes cannot be launched through it now (not reached, rootful); undefined: they can. */
  problem(): Promise<string | undefined>;
  /** Pull the image when it is not there yet; answers what the hopper reads of it. */
  pull(image: string): Promise<ImageInfo>;
  /** Build the image `tag` from this Containerfile when no image of that tag is there yet (issue #716). */
  build(tag: string, containerfile: string): Promise<void>;
  /** Make the volume; one that exists already is kept as it is. True: it made a new one. */
  createVolume(name: string, labels: Record<string, string>): Promise<boolean>;
  /** Remove the volume; one already gone is no error. */
  removeVolume(name: string): Promise<void>;
  /** Create the container; answers its id. */
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  /** Waits until the container ends, at most `timeoutMs`; answers its exit code. Throws when it did not end in time. */
  wait(id: string, timeoutMs: number): Promise<number>;
  /** What the container wrote (it runs on a terminal: one stream, as written). */
  logs(id: string): Promise<string>;
  /** The container by id or name; undefined: no such container. */
  inspect(id: string): Promise<ContainerInfo | undefined>;
  /** Stop it (a grace period, then killed); one already stopped or gone is no error. */
  stop(id: string): Promise<void>;
  /** Remove it, stopped or not; one already gone is no error. Its volumes stay. */
  remove(id: string): Promise<void>;
  /** The containers that carry every one of these labels; none given: every container. */
  list(labels?: Record<string, string>): Promise<ContainerInfo[]>;
}

/** One call of a runtime's API, as the remote runtime carries it to a machine's client (issue #708). */
export interface RuntimeRelayCall { method: string; path: string; body?: unknown; timeoutMs?: number }
/** The runtime's own answer: its status and its body. */
export interface RuntimeAnswer { status: number; text: string }

/** How the remote runtime reaches a client target's own runtime: its client says which it has, and runs each call. */
export interface RuntimeRelay {
  which(): Promise<{ kind: 'podman' | 'docker' } | { problem: string }>;
  call(c: RuntimeRelayCall): Promise<RuntimeAnswer>;
}

/** A range a template allows for one parameter: what a launch gets when it names none, and the most it may name. */
export interface LimitRange { default: number; max: number }

/**
 * What a template allows a launch to ask for (issue #708). `ttlMinutes`: absent, or with no `default`, a box of it has
 * no time limit unless the launch names one; absent `max`, any. `keepHome: false`: the home volume goes with the box.
 */
export interface TemplateLimits {
  cpus?: LimitRange;
  memoryMb?: LimitRange;
  ttlMinutes?: { default?: number; max?: number };
  keepHome?: boolean;
}

/** Why a template's limits cannot be saved: a default not more than 0, or more than its max. Undefined: they can. */
export function limitsProblem(l: TemplateLimits): string | undefined {
  const ranges: [string, { default?: number; max?: number } | undefined][] = [['cpus', l.cpus], ['memoryMb', l.memoryMb], ['ttlMinutes', l.ttlMinutes]];
  for (const [name, r] of ranges) {
    if (!r) continue;
    if (r.default !== undefined && !(r.default > 0)) return `${name}: the default must be more than 0`;
    if (r.max !== undefined && !(r.max > 0)) return `${name}: the max must be more than 0`;
    if (r.default !== undefined && r.max !== undefined && r.default > r.max) return `${name}: the default ${r.default} is more than the max ${r.max}`;
  }
  return undefined;
}

/** What a launch names (issue #708): each is optional; the template's defaults fill the rest. */
export interface LaunchParams {
  /** Which of the template's approved secrets the box may ask for; absent: all of them. */
  secrets?: string[];
  cpus?: number;
  memoryMb?: number;
  ttlMinutes?: number;
  /** One of the template's operation profiles, `operation/kind/name`. */
  profile?: string;
  /** Which of the template's tools the box gets (issue #716); absent: all of them. A box of no template: any tool. */
  tools?: string[];
}

/** The parameters a launch ran with once the template's defaults filled them in: what the sandbox record keeps. */
export interface ResolvedParams {
  secrets: string[];
  /** 0: no limit (a box taken on from before the records). */
  cpus: number;
  /** 0: no limit (a box taken on from before the records). */
  memoryMb: number;
  /** Absent: no time limit. */
  ttlMinutes?: number;
  profile?: string;
  /** The tools added to its image (issue #716); absent: none. */
  tools?: BoxTool[];
}

/** A sandbox record's state: `starting` until its client joins and a machine names it, then `ready`. */
export type SandboxState = 'starting' | 'ready';

/** The sandbox record (issue #708): one row of the instance's `sandboxes` table per box the hopper launched. */
export interface SandboxRecord {
  id: string;
  userId: string;
  /** The container's name, and the name of the machine it joins as. */
  name: string;
  agent: string;
  /** The template it is an instance of: its name, and the version (when it was saved) the launch read. */
  template?: { name: string; version: string };
  image: string;
  params: ResolvedParams;
  runtime: RuntimeKind;
  /** Where it runs: `local`, the computer the hopper runs on. */
  machine: string;
  /** The runtime's container id; empty while the launch makes it. */
  containerId: string;
  volume: string;
  /** Whether its home volume stays when it is removed. */
  keepHome: boolean;
  state: SandboxState;
  createdAt: string;
  /** Absent: no time limit. */
  expiresAt?: string;
  /** The URL the box dials the hopper at: written at launch, proven when it joins (state `ready`). */
  address: string;
}
