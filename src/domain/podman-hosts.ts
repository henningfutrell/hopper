// Podman hosts (issue #2272, design.md "Podman hosts"): a Linux computer with rootless Podman that a person set up for
// sandboxes, reached over ssh — the hopper's own key, the host's pinned key only — where each call of the Podman adapter
// goes down `podman system dial-stdio`. Not a machine: no hopper client, lane or job runs there, so the sandbox host may
// name it, and a box there may take vault secrets by a copy. Kept in the user's config record `podman-hosts`, read at
// each sandbox. This file is the pure part: a host as the record keeps it, and why one is not one.
import { HOST_KEY } from './machines.ts';

/** The config record that holds a user's Podman hosts. */
export const PODMAN_HOSTS = 'podman-hosts';

export interface PodmanHost {
  /** How the sandbox host names it. Never `local`, the runtime beside the hopper. */
  name: string;
  label?: string;
  /** The ssh destination: a plain `user@host` or `host`. */
  ssh: string;
  /** Its pinned host key, `<type> <base64>`: the only key the hopper accepts from it. */
  hostKey: string;
  /** The most CPUs and memory (MiB) a box gets there; absent: what each box asks for. */
  cpus?: number;
  memoryMb?: number;
}

export interface PodmanHostsConfig { hosts: PodmanHost[] }
/** `GET /api/podman-hosts`: the hosts, and the record's version to edit against. */
export interface PodmanHostsView { hosts: PodmanHost[]; version: string }

export const MAX_PODMAN_HOSTS = 20;
export const PODMAN_HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A plain `[user@]host`: it is also the host key's name in known_hosts, and an argument to ssh. */
export const PODMAN_SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
const MOST_CPUS = 256, MOST_MEMORY_MB = 1024 * 1024;

/** Why `h` is not a Podman host, or undefined. */
function hostProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'each Podman host is an object';
  const h = raw as Record<string, unknown>;
  const extra = Object.keys(h).find((k) => !['name', 'label', 'ssh', 'hostKey', 'cpus', 'memoryMb'].includes(k));
  if (extra) return `a Podman host has no field ${extra}`;
  if (typeof h.name !== 'string' || !PODMAN_HOST_NAME.test(h.name)) return 'a Podman host\'s name is lower case letters, digits and -, at most 40';
  if (h.name === 'local') return 'a Podman host is never named local: that is the runtime beside the hopper';
  const at = `Podman host ${h.name}`;
  if (h.label !== undefined && (typeof h.label !== 'string' || h.label.length > 80)) return `${at}: the label is a text of at most 80 characters`;
  if (typeof h.ssh !== 'string' || !PODMAN_SSH_TARGET.test(h.ssh)) return `${at}: ssh is a plain user@host or host`;
  if (typeof h.hostKey !== 'string' || !HOST_KEY.test(h.hostKey)) return `${at}: hostKey is the pinned host key, <type> <base64>`;
  if (h.cpus !== undefined && (typeof h.cpus !== 'number' || !(h.cpus > 0) || h.cpus > MOST_CPUS)) return `${at}: cpus is a number more than 0, at most ${MOST_CPUS}`;
  if (h.memoryMb !== undefined && (typeof h.memoryMb !== 'number' || !Number.isInteger(h.memoryMb) || h.memoryMb <= 0 || h.memoryMb > MOST_MEMORY_MB)) return `${at}: memoryMb is a whole number more than 0, at most ${MOST_MEMORY_MB}`;
  return undefined;
}

/** Why `raw` cannot be the `podman-hosts` record, or undefined. */
export function podmanHostsProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { hosts?: unknown }).hosts)) return 'the Podman hosts are { "hosts": [...] }';
  const extra = Object.keys(raw).find((k) => k !== 'hosts');
  if (extra) return `the Podman hosts have no field ${extra}`;
  const hosts = (raw as { hosts: unknown[] }).hosts;
  if (hosts.length > MAX_PODMAN_HOSTS) return `at most ${MAX_PODMAN_HOSTS} Podman hosts`;
  for (const h of hosts) {
    const p = hostProblem(h);
    if (p) return p;
  }
  const names = hosts.map((h) => (h as PodmanHost).name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  return twice ? `two Podman hosts are named ${twice}` : undefined;
}

/** The hosts a record holds; none while there is no record, or one that does not load. */
export const podmanHostsOf = (raw: unknown): PodmanHost[] => (raw === undefined || podmanHostsProblem(raw) ? [] : (raw as PodmanHostsConfig).hosts);
