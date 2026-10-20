// Sandbox boxes the hopper launches (issues #603, #708; design.md "Sandbox boxes the hopper launches"): the container
// runtime port, what a box is created as, the launch parameters a template allows, and the sandbox record.
import type { Duplex } from 'node:stream';

/**
 * The container runtimes the hopper can drive (issue #708). `remote` is an attached machine's, through its client;
 * `kubernetes` starts boxes as pods in a cluster, with no container socket (issue #1286).
 */
export const RUNTIME_KINDS = ['podman', 'docker', 'remote', 'kubernetes'] as const;
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

/** One image on a machine, as a runtime lists it (issue #1120): no tag is `tags: []`; `createdAt` in ms since the epoch. */
export interface ListedImage { id: string; tags: string[]; createdAt: number; labels: Record<string, string> }

/**
 * The tools the hopper adds to a box's image (issue #716, item 2): each from its own release, pinned, checked by its
 * SHA-256 (src/sandbox/tools.ts). A template names the ones its boxes get; a launch gets them, or names fewer.
 */
export const BOX_TOOLS = ['aws', 'helm', 'jq', 'kubectl', 'logcli', 'promtool', 'terraform'] as const;
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
  /**
   * Build the image `tag` from this Containerfile when no image of that tag is there yet (issue #716). Absent: this
   * runtime builds nothing (Kubernetes, issue #1286), and a box with tools runs the tools image CI published.
   */
  build?(tag: string, containerfile: string): Promise<void>;
  /** Make the volume; one that exists already is kept as it is. True: it made a new one. */
  createVolume(name: string, labels: Record<string, string>): Promise<boolean>;
  /** Remove the volume; one already gone is no error. */
  removeVolume(name: string): Promise<void>;
  /**
   * The volumes that carry every one of these labels, by the name removeVolume takes (issue #1371): what the sweeps read
   * to find a home no box holds. Every runtime lists them, one on a machine through its client too.
   */
  listVolumes(labels: Record<string, string>): Promise<string[]>;
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
  /** Extract the tar file `tar` (on this machine) into the directory `dir` of the running container, owned by its user. */
  copyIn?(id: string, dir: string, tar: string): Promise<void>;
  /**
   * A byte pipe to `cmd` started in the running box (issue #2146, the relay): what is written is its stdin, what is read
   * its stdout; an end of the writes ends its stdin. Absent: this runtime starts none (one on another machine, Kubernetes).
   */
  pipe?(id: string, cmd: readonly string[]): Promise<BoxPipe>;
  /** Every image on the machine, intermediate ones too (issue #1120). Absent: this runtime lists none (one on another machine). */
  listImages?(): Promise<ListedImage[]>;
  /**
   * Remove the image, never forced (issue #1120): true, it is removed; false, it is gone already, or the runtime keeps it
   * (a container uses it, or it is the parent of another). Throws on any other refusal.
   */
  removeImage?(id: string): Promise<boolean>;
}

/** A command's pipe in a box (issue #2146): its stdin and stdout as one stream, and the tail of its stderr. */
export type BoxPipe = Duplex & { stderr(): string };

/** A runtime that builds images: Podman, Docker, and a client target's through the remote runtime. */
export type BuildingRuntime = ContainerRuntime & Required<Pick<ContainerRuntime, 'build'>>;

/**
 * One call of a runtime's API, as the remote runtime carries it to a machine's client (issue #708): a JSON `body`, or
 * `tar`, a build's context in base64 (a tools image, issue #716).
 */
export interface RuntimeRelayCall { method: string; path: string; body?: unknown; tar?: string; timeoutMs?: number }
/** The runtime's own answer: its status and its body; `base64`, its bytes as they came (a check box's output, issue #708). */
export interface RuntimeAnswer { status: number; text: string; base64?: string }

/** How the remote runtime reaches a client target's own runtime: its client says which it has, and runs each call. */
export interface RuntimeRelay {
  which(): Promise<{ kind: 'podman' | 'docker' } | { problem: string }>;
  call(c: RuntimeRelayCall): Promise<RuntimeAnswer>;
}

/** A range a template allows for one parameter: what a launch gets when it names none, and the most it may name. */
export interface LimitRange { default: number; max: number }

/**
 * What a template allows a launch to ask for (issue #708). No time limit and no kept home (issue #1349): a sandbox does
 * one step and is burned with its home.
 */
export interface TemplateLimits {
  cpus?: LimitRange;
  memoryMb?: LimitRange;
}

/** Why a template's limits cannot be saved: a default not more than 0, or more than its max. Undefined: they can. */
export function limitsProblem(l: TemplateLimits): string | undefined {
  const ranges: [string, LimitRange | undefined][] = [['cpus', l.cpus], ['memoryMb', l.memoryMb]];
  for (const [name, r] of ranges) {
    if (!r) continue;
    if (r.default !== undefined && !(r.default > 0)) return `${name}: the default must be more than 0`;
    if (r.max !== undefined && !(r.max > 0)) return `${name}: the max must be more than 0`;
    if (r.default !== undefined && r.max !== undefined && r.default > r.max) return `${name}: the default ${r.default} is more than the max ${r.max}`;
  }
  return undefined;
}

/**
 * The sandbox record (issue #708): one row of the instance's `sandboxes` table per box an older build launched. The
 * hopper launches no box now (issue #1349): it burns each recorded box, and removes the record once the box is gone.
 * Only what the burn reads: a row holds more, as that build wrote it.
 */
export interface SandboxRecord {
  id: string;
  userId: string;
  /** The container's name. */
  name: string;
  image: string;
  /** Where it runs: `local`, the computer the hopper runs on, or a client target's name. */
  machine: string;
}

/** The network a box on none joins: a container target's command box (issue #865) reaches nothing. */
export const NO_NETWORK = 'none';

/** One command of a job on a container target (issue #865): the target's image, the script, and the job's variables. */
export interface CommandBox { jobId: string; image: string; script: string; env: Record<string, string>; timeoutMs: number }

/**
 * Container targets' commands through the sandbox module (issue #865 part C, design.md "Container targets"): each command
 * in a one-shot box of its own, on no network, burned after it. The box's output goes to `log` as it comes.
 */
export interface CommandBoxes {
  /** Why no box can start for the user now (no runtime, or it does not answer); undefined: one can. */
  problem(): Promise<string | undefined>;
  /** Never rejects: a failure of the box itself is `problem`, exit 125; `stopped`, the hopper stopped it. */
  run(box: CommandBox, io: { log(chunk: string): void; signal: AbortSignal }): Promise<{ exit: number; problem?: string; stopped?: 'timed-out' | 'cancelled' }>;
}
