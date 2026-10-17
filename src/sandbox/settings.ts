// The settings of the sandbox boxes the hopper starts: which container runtime, its socket or cluster, the boxes'
// network. Part of the daemon's settings (src/config.ts), kept here beside the runtimes they choose.
import { z } from 'zod';
import type { EgressSettings } from './egress.ts';
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
   * the hopper's pods, which a box's egress policy lets it reach; and the most CPU and memory a box gets (issue #1422,
   * the chart's `sandbox.limits`).
   */
  kubernetes?: { namespace?: string; hopperLabels: Record<string, string>; priorityClass?: string; most?: { cpus?: number; memoryMb?: number } };
  /** The network the boxes it starts join; unset: `hopper_default` in the container, `host` on the host. */
  sandboxNetwork?: string;
  /**
   * The egress of a read-only box beside the hopper (issue #849): the internal network it joins, the proxy it reaches out
   * through, and the directory the hopper shares the allowlist with the proxy in. Unset: a read-only box joins
   * `sandboxNetwork`, and its egress is open, which its read-only check finds.
   */
  egress?: EgressSettings;
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
  HOPPER_SANDBOX_EGRESS_NETWORK: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be the name of an internal Podman network').refine((v) => v !== 'host', 'must be an internal network, not host').optional(),
  HOPPER_SANDBOX_EGRESS_PROXY: z.string().regex(/^http:\/\/[A-Za-z0-9.-]+:\d+\/?$/, 'must be the proxy\'s URL, http://<name>:<port>').optional(),
  HOPPER_SANDBOX_EGRESS_DIR: z.string().regex(/^\//, 'must be an absolute path: the directory shared with the egress proxy').optional(),
  HOPPER_SANDBOX_RUNTIME: z.enum(['podman', 'docker', 'kubernetes']).optional(),
  HOPPER_KUBERNETES_NAMESPACE: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'must be a Kubernetes namespace name').optional(),
  HOPPER_KUBERNETES_HOPPER_LABELS: z.string()
    .regex(new RegExp(`^\\s*${label}(\\s*,\\s*${label})*\\s*$`), 'must be labels key=value, comma-separated')
    .transform((v) => Object.fromEntries(v.split(',').map((t) => t.trim().split('=') as [string, string]))).default({ 'app.kubernetes.io/name': 'hopper' }),
  HOPPER_KUBERNETES_PRIORITY_CLASS: z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'must be a PriorityClass name').optional(),
  HOPPER_KUBERNETES_BOX_CPUS: z.coerce.number().positive('must be a number of CPUs above 0').optional(),
  HOPPER_KUBERNETES_BOX_MEMORY_MB: z.coerce.number().int('must be a whole number of MiB').positive('must be a number of MiB above 0').optional(),
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
  HOPPER_SANDBOX_EGRESS_NETWORK: 'the internal network a read-only box and the read-only check box join beside the hopper (hopper_egress in compose.yaml): no way out but the egress proxy (docs/deploy.md "A read-only box\'s egress"). Set with HOPPER_SANDBOX_EGRESS_PROXY and HOPPER_SANDBOX_EGRESS_DIR. Unset: their egress is open, and their read-only check fails',
  HOPPER_SANDBOX_EGRESS_PROXY: 'the egress proxy a read-only box reaches out through (http://egress:3128 in compose.yaml): it allows only AWS, the clusters the vault mints for, and nothing else',
  HOPPER_SANDBOX_EGRESS_DIR: 'the directory the hopper writes the egress proxy\'s allowlist into, shared with the proxy (/run/hopper-egress in compose.yaml)',
  HOPPER_DOCKER_SOCKET: 'a rootless Docker Engine API socket the hopper starts sandbox boxes through when Podman is not given or not reached, or when HOPPER_SANDBOX_RUNTIME=docker. Unset: Docker is not used',
  HOPPER_SANDBOX_RUNTIME: 'podman, docker or kubernetes: the container runtime the hopper starts sandbox boxes through (kubernetes: as pods in a cluster, with no socket: docs/deploy.md "Sandbox boxes on Kubernetes"). Unset: Podman whenever it is reachable, else Docker',
  HOPPER_KUBERNETES_NAMESPACE: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the namespace sandbox boxes start in. Unset: the hopper\'s own',
  HOPPER_KUBERNETES_HOPPER_LABELS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the labels of the hopper\'s pods, key=value, comma-separated, which a box\'s egress policy lets it reach on the hopper\'s port',
  HOPPER_KUBERNETES_PRIORITY_CLASS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the PriorityClass every sandbox pod gets, so a ResourceQuota scoped to it holds the sandbox pods alone (the chart\'s sandbox.quota). Unset: none',
  HOPPER_KUBERNETES_BOX_CPUS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the most CPUs a box gets (the chart\'s sandbox.limits.cpus). Unset: what the box asks for (a need box 4)',
  HOPPER_KUBERNETES_BOX_MEMORY_MB: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the most memory a box gets, in MiB (the chart\'s sandbox.limits.memoryMb). Unset: what the box asks for (a need box 8192)',
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

/** The Kubernetes runtime's part, from its variables: the sandbox check reads the hopper's the same way (issue #1422). */
export function kubernetesSettings(e: Pick<Parsed, 'HOPPER_KUBERNETES_NAMESPACE' | 'HOPPER_KUBERNETES_HOPPER_LABELS' | 'HOPPER_KUBERNETES_PRIORITY_CLASS' | 'HOPPER_KUBERNETES_BOX_CPUS' | 'HOPPER_KUBERNETES_BOX_MEMORY_MB'>): NonNullable<SandboxSettings['kubernetes']> {
  const most = {
    ...(e.HOPPER_KUBERNETES_BOX_CPUS !== undefined ? { cpus: e.HOPPER_KUBERNETES_BOX_CPUS } : {}),
    ...(e.HOPPER_KUBERNETES_BOX_MEMORY_MB !== undefined ? { memoryMb: e.HOPPER_KUBERNETES_BOX_MEMORY_MB } : {}),
  };
  return {
    ...(e.HOPPER_KUBERNETES_NAMESPACE ? { namespace: e.HOPPER_KUBERNETES_NAMESPACE } : {}),
    hopperLabels: e.HOPPER_KUBERNETES_HOPPER_LABELS,
    ...(e.HOPPER_KUBERNETES_PRIORITY_CLASS ? { priorityClass: e.HOPPER_KUBERNETES_PRIORITY_CLASS } : {}),
    ...(Object.keys(most).length > 0 ? { most } : {}),
  };
}

const EGRESS = ['HOPPER_SANDBOX_EGRESS_NETWORK', 'HOPPER_SANDBOX_EGRESS_PROXY', 'HOPPER_SANDBOX_EGRESS_DIR'] as const;

/** Why the egress variables cannot run (issue #849): each one is set with the others, or none is. */
export function egressProblem(e: Pick<Parsed, (typeof EGRESS)[number]>): string | undefined {
  const set = EGRESS.filter((k) => e[k] !== undefined);
  return set.length === 0 || set.length === EGRESS.length ? undefined : `${EGRESS.filter((k) => e[k] === undefined).join(' and ')} must be set with ${set.join(' and ')}`;
}

/** The sandbox part of the daemon's config, from its parsed variables. */
export function sandboxSettings(e: Parsed): SandboxSettings {
  return {
    ...(e.HOPPER_PODMAN_SOCKET ? { podmanSocket: e.HOPPER_PODMAN_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_NETWORK ? { sandboxNetwork: e.HOPPER_SANDBOX_NETWORK } : {}),
    ...(e.HOPPER_DOCKER_SOCKET ? { dockerSocket: e.HOPPER_DOCKER_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_EGRESS_NETWORK && e.HOPPER_SANDBOX_EGRESS_PROXY && e.HOPPER_SANDBOX_EGRESS_DIR
      ? { egress: { network: e.HOPPER_SANDBOX_EGRESS_NETWORK, proxy: e.HOPPER_SANDBOX_EGRESS_PROXY.replace(/\/$/, ''), dir: e.HOPPER_SANDBOX_EGRESS_DIR } }
      : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME ? { sandboxRuntime: e.HOPPER_SANDBOX_RUNTIME } : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME === 'kubernetes' ? { kubernetes: kubernetesSettings(e) } : {}),
    playground: {
      maxConcurrent: e.HOPPER_SANDBOX_MAX_CONCURRENT, maxPerUser: e.HOPPER_SANDBOX_MAX_PER_USER,
      defaults: { cpus: e.HOPPER_SANDBOX_DEFAULT_CPUS, memoryMb: e.HOPPER_SANDBOX_DEFAULT_MEMORY_MB, ttlMinutes: e.HOPPER_SANDBOX_DEFAULT_TTL_MINUTES },
      max: { cpus: e.HOPPER_SANDBOX_MAX_CPUS, memoryMb: e.HOPPER_SANDBOX_MAX_MEMORY_MB, ttlMinutes: e.HOPPER_SANDBOX_MAX_TTL_MINUTES },
    },
  };
}
