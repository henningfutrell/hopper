// In a Kubernetes pod (issue #1289, design.md "Host-only parts in a cluster"): found by KUBERNETES_SERVICE_HOST, which
// Kubernetes gives every container of a pod. A pod has no WSL, no systemd and no container runtime socket: the parts
// that read the host (the WSL memory and Windows link, the socket's problem, the compose tunnel services, the network fix)
// keep still there. A pod's resources are its limits: the cgroup's, else the ones the chart passes through the Downward
// API (HOPPER_POD_CPU_LIMIT in millicores, HOPPER_POD_MEMORY_LIMIT in bytes), which Kubernetes sets to the node's
// allocatable when the pod sets no limit.
// Imports nothing of hopper: a client target runs it as a plain file.

export type Env = Record<string, string | undefined>;

/** Whether this process runs in a Kubernetes pod. */
export const inCluster = (env: Env = process.env): boolean => Boolean(env.KUBERNETES_SERVICE_HOST);

/** A pod's limits through the Downward API: cores (may be fractional) and memory in bytes; each absent when not given or not sane. */
export interface PodLimits { cores?: number; memBytes?: number }

const positive = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);

export function podLimits(env: Env = process.env): PodLimits {
  const milli = positive(env.HOPPER_POD_CPU_LIMIT);
  const mem = positive(env.HOPPER_POD_MEMORY_LIMIT);
  return { ...(milli !== undefined ? { cores: milli / 1000 } : {}), ...(mem !== undefined ? { memBytes: mem } : {}) };
}
