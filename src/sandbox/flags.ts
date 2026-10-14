// The sandbox flags (issue #708): built here, once, for every way a box is made — the libpod create body, the Docker
// Engine create body, and the `run` line Add machine shows (GET /api/sandboxes `line`). Nothing a request carries
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
