// The sandbox flags (issue #708): built here, once, for every way a box is made — the libpod create body, the Docker
// Engine create body, the Kubernetes pod (issue #1286), and the `run` line Add machine shows (GET /api/sandboxes `line`). Nothing a request carries
// reaches them but the resource limits, which the launch checked against its template first.
import type { ContainerSpec, ResourceLimits } from '../domain/sandboxes.ts';

/** Where a box's home volume is mounted: the box image's agent user's home. */
export const HOME = '/home/agent';
/** How long a box may take to stop before it is killed, in seconds. */
export const STOP_S = 10;
const TMPFS_OPTIONS = ['rw', 'nosuid', 'nodev'];
const CPU_PERIOD = 100_000;
const MIB = 1024 * 1024;
const S = 1_000_000_000;

/** What a box's start check fetches of the hopper: the client install script, which any machine may read. */
export const START_CHECK_PATH = '/client/install';

/**
 * The start check (issue #708): the box's health check. It runs in the box, with bash and no profile or rc file (#518),
 * and fetches the hopper at the box's address, with the Host the box's client sends: a refusal (403, 421) fails it too.
 */
export function startCheckTest(url: string): string[] {
  const at = `${url}${START_CHECK_PATH}`.replaceAll("'", `'\\''`);
  return ['CMD', 'bash', '--noprofile', '--norc', '-c', `curl -fsS -m 5 -o /dev/null '${at}'`];
}

/** Whether the user an image runs as is root: none set, `root` or uid 0, with or without a group. */
export function isRootUser(user: string): boolean {
  const name = user.split(':')[0]!.trim();
  return name === '' || name === 'root' || name === '0';
}

/** The `run` flags of a box, as Podman and Docker both take them: the sandbox flags and the resource limits. */
export function runFlags(limits: ResourceLimits): string[] {
  return [
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', `/tmp:${TMPFS_OPTIONS.join(',')}`,
    '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`,
  ];
}

/** The libpod create body (Podman's own API, `/libpod/containers/create`). */
export function libpodCreateBody(spec: ContainerSpec): Record<string, unknown> {
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
    ...(spec.network === 'host' ? { netns: { nsmode: 'host' } } : { netns: { nsmode: 'bridge' }, networks: { [spec.network]: {} } }),
    // No interval: Podman runs it only when the hopper asks, so no timer on the computer is needed (WSL has none).
    ...(spec.check !== undefined ? { healthconfig: { Test: startCheckTest(spec.check), Interval: 0, Timeout: 10 * S, Retries: 1 } } : {}),
  };
}

/** The Docker Engine create body (`/containers/create?name=`). */
export function dockerCreateBody(spec: ContainerSpec): Record<string, unknown> {
  return {
    Image: spec.image, Labels: spec.labels, User: spec.user, Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    ...(spec.script !== undefined ? { Entrypoint: ['/bin/sh'], Cmd: ['-c', spec.script], Tty: true } : {}),
    // Docker runs a health check only on its own interval: the hopper reads its last run.
    ...(spec.check !== undefined ? { Healthcheck: { Test: startCheckTest(spec.check), Interval: 10 * S, Timeout: 10 * S, Retries: 1 } } : {}),
    HostConfig: {
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true,
      Tmpfs: { '/tmp': TMPFS_OPTIONS.join(',') },
      Mounts: [{ Type: 'volume', Source: spec.volume, Target: HOME }],
      NanoCpus: Math.round(spec.limits.cpus * 1e9), Memory: spec.limits.memoryMb * MIB,
      RestartPolicy: { Name: spec.script !== undefined ? 'no' : 'unless-stopped' },
      NetworkMode: spec.network,
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

/** What a box's pod asks the node for (issue #1371): its limits are a ceiling, not a reservation. */
const REQUEST_FLOOR = { cpus: 0.1, memoryMb: 256 } as const;

/**
 * The Kubernetes pod of a box (issue #1286): the sandbox flags as its security context — every capability dropped, no
 * privilege escalation, a read-only root, `/tmp` an empty dir, the home its claim, a non-root user by number — with no
 * service account token, no service links, nothing of the node. A one-shot container runs its script and is never
 * restarted; a box is restarted, as `unless-stopped`.
 */
export function kubernetesPodBody(spec: ContainerSpec, o: { name: string; claim: string; labels: Record<string, string>; annotations: Record<string, string> }): Record<string, unknown> {
  const { uid, gid } = numericUser(spec.user);
  const { cpus, memoryMb } = spec.limits;
  const limits = { ...(cpus > 0 ? { cpu: String(cpus) } : {}), ...(memoryMb > 0 ? { memory: `${memoryMb}Mi` } : {}) };
  // A limit is a ceiling, as Podman's `--cpus` is: the node holds only a small floor, never the limit, for the box.
  const requests = {
    ...(cpus > 0 ? { cpu: cpus < REQUEST_FLOOR.cpus ? String(cpus) : `${REQUEST_FLOOR.cpus * 1000}m` } : {}),
    ...(memoryMb > 0 ? { memory: `${Math.min(memoryMb, REQUEST_FLOOR.memoryMb)}Mi` } : {}),
  };
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: o.name, labels: o.labels, annotations: o.annotations },
    spec: {
      automountServiceAccountToken: false, enableServiceLinks: false,
      restartPolicy: spec.script !== undefined ? 'Never' : 'Always',
      terminationGracePeriodSeconds: STOP_S,
      securityContext: { runAsNonRoot: true, runAsUser: uid, runAsGroup: gid, fsGroup: gid, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: KUBERNETES_CONTAINER, image: spec.image, imagePullPolicy: 'IfNotPresent',
        env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
        ...(spec.script !== undefined ? { command: ['/bin/sh', '-c', spec.script] } : {}),
        securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        ...(Object.keys(limits).length ? { resources: { limits, requests } } : {}),
        volumeMounts: [{ name: 'home', mountPath: HOME }, { name: 'tmp', mountPath: '/tmp' }],
      }],
      volumes: [{ name: 'home', persistentVolumeClaim: { claimName: o.claim } }, { name: 'tmp', emptyDir: {} }],
    },
  };
}
