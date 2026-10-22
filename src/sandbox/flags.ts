// The sandbox flags (issue #708): built here, once, for every way a box is made — the libpod create body, the Docker
// Engine create body, and the Kubernetes pod (issue #1286). Nothing a request carries reaches them but the resource
// limits, which the step checked against its template first.
import { NO_NETWORK, type ContainerSpec } from '../domain/sandboxes.ts';

/** Where a box's home volume is mounted: the box image's agent user's home. */
export const HOME = '/home/agent';
/** How long a box may take to stop before it is killed, in seconds. */
export const STOP_S = 10;
const TMPFS_OPTIONS = ['rw', 'nosuid', 'nodev'];
const CPU_PERIOD = 100_000;
const MIB = 1024 * 1024;

/** Whether the user an image runs as is root: none set, `root` or uid 0, with or without a group. */
export function isRootUser(user: string): boolean {
  const name = user.split(':')[0]!.trim();
  return name === '' || name === 'root' || name === '0';
}
/**
 * `fileLog`: a one-shot container keeps its log in a file (issue #2406), as the runtime's own: journald, Podman's default on
 * a systemd host, drops most of an output over about 1 MB, and a need step's outputs come back in its log. Only over the
 * runtime's socket: a machine's client (src/client/runtime.ts) takes no log setting.
 */
export interface CreateOptions { fileLog?: boolean }

/** The libpod create body (Podman's own API, `/libpod/containers/create`). */
export function libpodCreateBody(spec: ContainerSpec, o: CreateOptions = {}): Record<string, unknown> {
  return {
    name: spec.name, image: spec.image, labels: spec.labels, env: spec.env, user: spec.user,
    cap_drop: ['ALL'], no_new_privileges: true, read_only_filesystem: true, read_only_tmpfs: false,
    mounts: [{ destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: TMPFS_OPTIONS }],
    volumes: [{ Name: spec.volume, Dest: HOME }],
    resource_limits: {
      cpu: { quota: Math.round(spec.limits.cpus * CPU_PERIOD), period: CPU_PERIOD },
      memory: { limit: spec.limits.memoryMb * MIB },
    },
    // A one-shot container (issue #716): its script on a terminal, in place of the entrypoint, never restarted.
    ...(spec.script !== undefined ? { entrypoint: ['/bin/sh'], command: ['-c', spec.script], terminal: true, restart_policy: 'no' } : { restart_policy: 'unless-stopped' }),
    ...(spec.script !== undefined && o.fileLog ? { log_configuration: { driver: 'k8s-file' } } : {}),
    ...(spec.network === 'host' || spec.network === NO_NETWORK ? { netns: { nsmode: spec.network } } : { netns: { nsmode: 'bridge' }, networks: { [spec.network]: {} } }),
  };
}

/** The Docker Engine create body (`/containers/create?name=`). */
export function dockerCreateBody(spec: ContainerSpec, o: CreateOptions = {}): Record<string, unknown> {
  return {
    Image: spec.image, Labels: spec.labels, User: spec.user, Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    ...(spec.script !== undefined ? { Entrypoint: ['/bin/sh'], Cmd: ['-c', spec.script], Tty: true } : {}),
    HostConfig: {
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true,
      Tmpfs: { '/tmp': TMPFS_OPTIONS.join(',') },
      Mounts: [{ Type: 'volume', Source: spec.volume, Target: HOME }],
      NanoCpus: Math.round(spec.limits.cpus * 1e9), Memory: spec.limits.memoryMb * MIB,
      RestartPolicy: { Name: spec.script !== undefined ? 'no' : 'unless-stopped' },
      NetworkMode: spec.network,
      ...(spec.script !== undefined && o.fileLog ? { LogConfig: { Type: 'json-file' } } : {}),
    },
  };
}

/** On Kubernetes (issue #1286) a box runs as this user: the box image's own agent user (scripts/box/Dockerfile), by number. */
export const KUBERNETES_USER = '1000:1000';
/** The one container of a box's pod. */
export const KUBERNETES_CONTAINER = 'box';

/** The uid and gid of a user given by number; the kubelet can refuse root only by number. Throws for a name, or root. */
function numericUser(user: string): { uid: number; gid: number } {
  const m = /^(\d+)(?::(\d+))?$/.exec(user.trim());
  if (!m) throw new Error(`on Kubernetes a box runs as a user given by number, not ${user || 'none'}`);
  const uid = Number(m[1]), gid = m[2] === undefined ? uid : Number(m[2]);
  if (uid === 0 || gid === 0) throw new Error('a sandbox box runs as a non-root user: uid and gid 0 are root');
  return { uid, gid };
}

/**
 * The Kubernetes pod of a box (issue #1286): the sandbox flags as its security context — every capability dropped, no
 * privilege escalation, a read-only root, `/tmp` an empty dir, the home its claim, a non-root user by number — with no
 * service account token, no service links, nothing of the node. A one-shot container runs its script and is never
 * restarted; a box is restarted, as `unless-stopped`.
 */
export function kubernetesPodBody(spec: ContainerSpec, o: { name: string; claim: string; labels: Record<string, string>; annotations: Record<string, string>; priorityClass?: string }): Record<string, unknown> {
  const { uid, gid } = numericUser(spec.user);
  const limits = { ...(spec.limits.cpus > 0 ? { cpu: String(spec.limits.cpus) } : {}), ...(spec.limits.memoryMb > 0 ? { memory: `${spec.limits.memoryMb}Mi` } : {}) };
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: o.name, labels: o.labels, annotations: o.annotations },
    spec: {
      automountServiceAccountToken: false, enableServiceLinks: false,
      restartPolicy: spec.script !== undefined ? 'Never' : 'Always',
      terminationGracePeriodSeconds: STOP_S,
      // A ResourceQuota scoped to this PriorityClass holds the sandbox pods alone (issue #1410, the chart's sandbox.quota).
      ...(o.priorityClass !== undefined ? { priorityClassName: o.priorityClass } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: uid, runAsGroup: gid, fsGroup: gid, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: KUBERNETES_CONTAINER, image: spec.image, imagePullPolicy: 'IfNotPresent',
        env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
        ...(spec.script !== undefined ? { command: ['/bin/sh', '-c', spec.script] } : {}),
        securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        ...(Object.keys(limits).length ? { resources: { limits } } : {}),
        volumeMounts: [{ name: 'home', mountPath: HOME }, { name: 'tmp', mountPath: '/tmp' }],
      }],
      volumes: [{ name: 'home', persistentVolumeClaim: { claimName: o.claim } }, { name: 'tmp', emptyDir: {} }],
    },
  };
}
