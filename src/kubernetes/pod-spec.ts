// A job pod's manifest (issue #1283, design.md "Job pods on Kubernetes"). Pure. The pod runs the sandbox box's image
// (scripts/box): herdr's session and the hopper client, which joins with the job's one-time join line and dials out
// to the hopper. Nothing listens in it — no sshd, no container port —, so the hopper never opens a connection into it.
// It runs as the image's unprivileged user, with no service account token, every capability dropped, a read-only root,
// and its home on the work volume: an emptyDir, or a directory of its own on a persistent volume claim.
import { POD_INSTANCE_LABEL, POD_JOB_LABEL, type PodManifest } from '../domain/pods.ts';

/** The sandbox box's image for claude, the agent herdr-claude drives on a client target. */
export const JOB_POD_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

/** The box image's user (scripts/box/Dockerfile: node's user, renamed `agent`) and its home. */
export const JOB_POD_UID = 1000;
const HOME = '/home/agent';

/** Where the job pod's home lives: an emptyDir (gone with the pod), or a persistent volume claim's directory for the pod. */
export type WorkVolume = { emptyDir: { sizeLimitGiB?: number } } | { claim: string };

export interface JobPodInput {
  /** The pod's name: `jobPodName(jobId)`. */
  name: string;
  jobId: string;
  /** The hopper's instance id: the instance label. */
  instanceId: string;
  image: string;
  /** `<hopper URL>#<join code>`: the line the client joins with once. */
  joinLine: string;
  volume: WorkVolume;
  cpus: number;
  memoryMb: number;
  /** The image pull secret, when the image's registry needs one. */
  pullSecret?: string;
}

/** A job's pod name: `hopper-job-<job id>`, a DNS label and a machine name at once. Throws on a job id that is neither. */
export function jobPodName(jobId: string): string {
  const name = `hopper-job-${jobId.toLowerCase()}`;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error(`job id ${JSON.stringify(jobId)} makes no pod name`);
  return name;
}

/** A Kubernetes label value: at most 63 of `[A-Za-z0-9_.-]`, alphanumeric at both ends. */
export const labelValue = (v: string): string => {
  const s = v.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return s || 'none';
};

/** The pod for one job. */
export function jobPod(i: JobPodInput): PodManifest {
  const volume = 'claim' in i.volume
    ? { name: 'home', persistentVolumeClaim: { claimName: i.volume.claim } }
    : { name: 'home', emptyDir: i.volume.emptyDir.sizeLimitGiB ? { sizeLimit: `${i.volume.emptyDir.sizeLimitGiB}Gi` } : {} };
  // A claim is shared by every job pod: each gets a directory of its own on it.
  const subPath = 'claim' in i.volume ? { subPath: i.name } : {};
  const security = {
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: JOB_POD_UID, runAsGroup: JOB_POD_UID,
    capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
  };
  const resources = { requests: { cpu: String(i.cpus), memory: `${i.memoryMb}Mi` }, limits: { cpu: String(i.cpus), memory: `${i.memoryMb}Mi` } };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: i.name, labels: { 'app.kubernetes.io/name': 'hopper-job', 'app.kubernetes.io/managed-by': 'hopper', [POD_INSTANCE_LABEL]: labelValue(i.instanceId), [POD_JOB_LABEL]: labelValue(i.jobId) } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: JOB_POD_UID, runAsGroup: JOB_POD_UID, fsGroup: JOB_POD_UID, seccompProfile: { type: 'RuntimeDefault' } },
      ...(i.pullSecret ? { imagePullSecrets: [{ name: i.pullSecret }] } : {}),
      // The image's home (its seeded agent config) copied onto the work volume, which hides it from then on.
      initContainers: [{
        name: 'home', image: i.image, command: ['sh', '-c', `cp -a ${HOME}/. /mnt/home/`],
        securityContext: security, volumeMounts: [{ name: 'home', mountPath: '/mnt/home', ...subPath }], resources,
      }],
      containers: [{
        name: 'job', image: i.image, command: ['/usr/local/bin/hopper-box'],
        // The box's entrypoint moves the join line to a file and runs again without it (issue #606).
        env: [{ name: 'HOPPER_CLIENT_NAME', value: i.name }, { name: 'HOPPER_JOIN', value: i.joinLine }, { name: 'HOME', value: HOME }],
        securityContext: security, resources,
        volumeMounts: [{ name: 'home', mountPath: HOME, ...subPath }, { name: 'tmp', mountPath: '/tmp' }],
      }],
      volumes: [volume, { name: 'tmp', emptyDir: {} }],
    },
  };
}
