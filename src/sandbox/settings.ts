// The settings of the sandbox boxes the hopper starts: which container runtime, its socket or cluster, the boxes'
// network. Part of the daemon's settings (src/config.ts), kept here beside the runtimes they choose.
import { z } from 'zod';

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
  kubernetes?: { namespace?: string; hopperLabels: Record<string, string> };
  /** The network the boxes it starts join; unset: `hopper_default` in the container, `host` on the host. */
  sandboxNetwork?: string;
}

const label = '[A-Za-z0-9][-A-Za-z0-9_./]*=[-A-Za-z0-9_.]*';

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
};

export const SANDBOX_SETTING_HELP: Record<keyof typeof SANDBOX_SETTINGS, string> = {
  HOPPER_PODMAN_SOCKET: 'the rootless Podman API socket the hopper starts, stops and removes sandbox boxes through (/run/podman/podman.sock in the container: docs/deploy.md "Sandbox boxes the hopper starts"). Unset: Add machine shows the line to run instead',
  HOPPER_SANDBOX_NETWORK: 'the network the boxes the hopper starts join. Unset: hopper_default in the container (HOPPER_LOCAL_MACHINE=false), host on the host',
  HOPPER_DOCKER_SOCKET: 'a rootless Docker Engine API socket the hopper starts sandbox boxes through when Podman is not given or not reached, or when HOPPER_SANDBOX_RUNTIME=docker. Unset: Docker is not used',
  HOPPER_SANDBOX_RUNTIME: 'podman, docker or kubernetes: the container runtime the hopper starts sandbox boxes through (kubernetes: as pods in a cluster, with no socket: docs/deploy.md "Sandbox boxes on Kubernetes"). Unset: Podman whenever it is reachable, else Docker',
  HOPPER_KUBERNETES_NAMESPACE: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the namespace sandbox boxes start in. Unset: the hopper\'s own',
  HOPPER_KUBERNETES_HOPPER_LABELS: 'with HOPPER_SANDBOX_RUNTIME=kubernetes: the labels of the hopper\'s pods, key=value, comma-separated, which a box\'s egress policy lets it reach on the hopper\'s port',
};

type Parsed = z.infer<z.ZodObject<typeof SANDBOX_SETTINGS>>;

/** The sandbox part of the daemon's config, from its parsed variables. */
export function sandboxSettings(e: Parsed): SandboxSettings {
  return {
    ...(e.HOPPER_PODMAN_SOCKET ? { podmanSocket: e.HOPPER_PODMAN_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_NETWORK ? { sandboxNetwork: e.HOPPER_SANDBOX_NETWORK } : {}),
    ...(e.HOPPER_DOCKER_SOCKET ? { dockerSocket: e.HOPPER_DOCKER_SOCKET } : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME ? { sandboxRuntime: e.HOPPER_SANDBOX_RUNTIME } : {}),
    ...(e.HOPPER_SANDBOX_RUNTIME === 'kubernetes' ? { kubernetes: { ...(e.HOPPER_KUBERNETES_NAMESPACE ? { namespace: e.HOPPER_KUBERNETES_NAMESPACE } : {}), hopperLabels: e.HOPPER_KUBERNETES_HOPPER_LABELS } } : {}),
  };
}
