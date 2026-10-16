// The settings of the sandbox boxes the hopper starts: which container runtime, its socket or cluster, the boxes'
// network. Part of the daemon's settings (src/config.ts), kept here beside the runtimes they choose.
import { z } from 'zod';
import { PLAYGROUND_LIMITS, type PlaygroundLimits } from './playground.ts';

export interface SandboxSettings {
  /** The rootless Podman API socket the hopper starts sandbox boxes through (issue #603); unset: it starts none. */
  podmanSocket?: string;
  /** The rootless Docker Engine API socket (issue #708): used when Podman is not given or not reached, or chosen. */
  dockerSocket?: string;
  /** The container runtime chosen (issue #708); unset: Podman whenever it is reachable (src/sandbox/runtime.ts). */
  sandboxRuntime?: 'podman' | 'docker' | 'kubernetes';
  /**
   * With the Kubernetes runtime (issue #1286): the namespace boxes start in (unset: the hopper's own), and the labels of
   * the hopper's pods, which a box's egress policy lets it reach.
   */
  kubernetes?: { namespace?: string; hopperLabels: Record<string, string>; priorityClass?: string };
  /** The network the boxes it starts join; unset: `hopper_default` in the container, `host` on the host. */
  sandboxNetwork?: string;
  /** The sandbox playground's limits (issue #1410). */
  playground: PlaygroundLimits;
}

const label = '[A-Za-z0-9][-A-Za-z0-9_./]*=[-A-Za-z0-9_.]*';
/** A count of playground sandboxes; 0: none start. */
const count = (d: number) => z.coerce.number().int().min(0).max(10_000).default(d);
/** A size of one playground sandbox: more than 0, whole when `int`. */
const size = (d: number, int = false) => (int ? z.coerce.number().int() : z.coerce.number()).positive().max(16 * 1024 * 1024).default(d);

/** The variables, as fields of the daemon's settings schema. */
export const SANDBOX_SETTINGS = {
  HOPPER_PODMAN_SOCKET: z.string().regex(/^\//, 'must be an absolute path: the Podman API socket').optional(),
  HOPPER_SANDBOX_NETWORK: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be a Podman network name, or host').optional(),
  HOPPER_DOCKER_SOCKET: z.string().regex(/^\//, 'must be an absolute path: the Docker Engine API socket').optional(),
  HOPPER_SANDBOX_RUNTIME: z.enum(['podman', 'docker', 'kubernetes']).optional(),
  HOPPER_KUBERNETES_NAMESPACE: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'must be a Kubernetes namespace name').optional(),
  HOPPER_KUBERNETES_HOPPER_LABELS: z.string()
    .regex(new RegExp(`^\\s*${label}(\\s*,\\s*${label})*\\s*$`), 'must be labels key=value, comma-separated')
    .transform((v) => Object.fromEntries(v.split(',').map((t) => t.trim().split('=') as [string, string]))).default({ 'app.kubernetes.io/name': 'hopper' }),
  HOPPER_KUBERNETES_PRIORITY_CLASS: z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'must be a PriorityClass name').optional(),
  HOPPER_SANDBOX_MAX_CONCURRENT: count(PLAYGROUND_LIMITS.maxConcurrent),
  HOPPER_SANDBOX_MAX_PER_USER: count(PLAYGROUND_LIMITS.maxPerUser),
  HOPPER_SANDBOX_DEFAULT_CPUS: size(PLAYGROUND_LIMITS.defaults.cpus),
  HOPPER_SANDBOX_DEFAULT_MEMORY_MB: size(PLAYGROUND_LIMITS.defaults.memoryMb, true),
  HOPPER_SANDBOX_DEFAULT_TTL_MINUTES: size(PLAYGROUND_LIMITS.defaults.ttlMinutes, true),
  HOPPER_SANDBOX_MAX_CPUS: size(PLAYGROUND_LIMITS.max.cpus),
  HOPPER_SANDBOX_MAX_MEMORY_MB: size(PLAYGROUND_LIMITS.max.memoryMb, true),
  HOPPER_SANDBOX_MAX_TTL_MINUTES: size(PLAYGROUND_LIMITS.max.ttlMinutes, true),
};

export const SANDBOX_SETTING_HELP: Record<keyof typeof SANDBOX_SETTINGS, string> = {
  HOPPER_PODMAN_SOCKET: 'the rootless Podman API socket the hopper starts, stops and removes sandboxes through (/run/podman/podman.sock in the container: docs/deploy.md "Sandboxes the hopper starts"). Unset: a step runs on a machine of the user with a runtime, else it fails',
  HOPPER_SANDBOX_NETWORK: 'the network the boxes the hopper starts join. Unset: hopper_default in the container (HOPPER_LOCAL_MACHINE=false), host on the host',
  HOPPER_DOCKER_SOCKET: 'a rootless Docker Engine API socket the hopper starts sandbox boxes through when Podman is not given or not reached, or when HOPPER_SANDBOX_RUNTIME=docker. Unset: Docker is not used',
  HOPPER_SANDBOX_RUNTIME: 'podman, docker or kubernetes: the container runtime the hopper starts sandbox boxes through (kubernetes: as pods in a cluster, with no socket: docs/deploy.md "Sandbox boxes on Kubernetes"). Unset: Podman whenever it is reachable, else Docker',
  HOPPER_KUBERNETES_NAMESPACE: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the namespace sandbox boxes start in. Unset: the hopper\'s own',
  HOPPER_KUBERNETES_HOPPER_LABELS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the labels of the hopper\'s pods, key=value, comma-separated, which a box\'s egress policy lets it reach on the hopper\'s port',
  HOPPER_KUBERNETES_PRIORITY_CLASS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the PriorityClass every sandbox pod gets, so a ResourceQuota scoped to it holds the sandbox pods alone (the chart\'s sandbox.quota). Unset: none',
  HOPPER_SANDBOX_MAX_CONCURRENT: 'how many sandbox playground sandboxes run at once, all users together (docs/deploy.md "The sandbox playground"); over it a create is refused with 429. 0: none start',
  HOPPER_SANDBOX_MAX_PER_USER: 'how many sandbox playground sandboxes one user runs at once; over it a create is refused with 429. 0: none start',
  HOPPER_SANDBOX_DEFAULT_CPUS: 'the CPUs of a playground sandbox when the create and its template name none',
  HOPPER_SANDBOX_DEFAULT_MEMORY_MB: 'the memory, in MiB, of a playground sandbox when the create and its template name none',
  HOPPER_SANDBOX_DEFAULT_TTL_MINUTES: 'the time limit, in minutes, of a playground sandbox when the create and its template name none: past it the sandbox is destroyed',
  HOPPER_SANDBOX_MAX_CPUS: 'the most CPUs a playground sandbox may ask for; more is refused with 400',
  HOPPER_SANDBOX_MAX_MEMORY_MB: 'the most memory, in MiB, a playground sandbox may ask for; more is refused with 400',
  HOPPER_SANDBOX_MAX_TTL_MINUTES: 'the longest time limit, in minutes, a playground sandbox may ask for; more is refused with 400',
};

type Parsed = z.infer<z.ZodObject<typeof SANDBOX_SETTINGS>>;

/** The sandbox part of the daemon's config, from its parsed variables. */
export function sandboxSettings(e: Parsed): SandboxSettings {
  return {
    ...(e.HOPPER_PODMAN_SOCKET ? { podmanSocket: e.HOPPER_PODMAN_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_NETWORK ? { sandboxNetwork: e.HOPPER_SANDBOX_NETWORK } : {}),
    ...(e.HOPPER_DOCKER_SOCKET ? { dockerSocket: e.HOPPER_DOCKER_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME ? { sandboxRuntime: e.HOPPER_SANDBOX_RUNTIME } : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME === 'kubernetes' ? { kubernetes: {
      ...(e.HOPPER_KUBERNETES_NAMESPACE ? { namespace: e.HOPPER_KUBERNETES_NAMESPACE } : {}), hopperLabels: e.HOPPER_KUBERNETES_HOPPER_LABELS,
      ...(e.HOPPER_KUBERNETES_PRIORITY_CLASS ? { priorityClass: e.HOPPER_KUBERNETES_PRIORITY_CLASS } : {}),
    } } : {}),
    playground: {
      maxConcurrent: e.HOPPER_SANDBOX_MAX_CONCURRENT, maxPerUser: e.HOPPER_SANDBOX_MAX_PER_USER,
      defaults: { cpus: e.HOPPER_SANDBOX_DEFAULT_CPUS, memoryMb: e.HOPPER_SANDBOX_DEFAULT_MEMORY_MB, ttlMinutes: e.HOPPER_SANDBOX_DEFAULT_TTL_MINUTES },
      max: { cpus: e.HOPPER_SANDBOX_MAX_CPUS, memoryMb: e.HOPPER_SANDBOX_MAX_MEMORY_MB, ttlMinutes: e.HOPPER_SANDBOX_MAX_TTL_MINUTES },
    },
  };
}
