// Job pods (issue #1283, design.md "Job pods on Kubernetes"): one pod per job, started through the Kubernetes API in
// the hopper's own namespace, which runs the job's agent and dials out to the hopper as a client target. Types only.

/** A pod as the Kubernetes API takes it: the manifest `jobPod` (src/kubernetes/pod-spec.ts) builds. */
export type PodManifest = Record<string, unknown>;

/** A pod's phase, as the Kubernetes API says it, and why it ended when it did. */
export interface PodState { phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'; reason?: string }

/**
 * The Kubernetes API, as job pods use it: pods in one namespace, and nothing else. The service account the hopper runs
 * as may only manage pods in that namespace (deploy/kubernetes/rbac.yaml); every call names it.
 */
export interface KubernetesPods {
  /** The namespace every call is in. */
  readonly namespace: string;
  /** Why the API cannot be used now (not reached, refused); undefined when it answers. */
  problem(): Promise<string | undefined>;
  /** Creates the pod. Rejects with the API's reason. */
  create(pod: PodManifest): Promise<void>;
  /** The pod's state; undefined when there is no such pod. */
  state(name: string): Promise<PodState | undefined>;
  /** Deletes the pod; a pod that is not there is no error. */
  remove(name: string): Promise<void>;
  /** The names of the pods that carry every one of these labels. */
  list(labels: Readonly<Record<string, string>>): Promise<string[]>;
}

/** The label each job pod carries: the hopper's instance id, so one hopper never removes another's pods. */
export const POD_INSTANCE_LABEL = 'io.hopper/instance';
/** The label naming the job a pod runs. */
export const POD_JOB_LABEL = 'io.hopper/job';
