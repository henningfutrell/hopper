// The user's Podman hosts (issue #2272): the config record `podman-hosts`, read and replaced whole against its version,
// from the UI (POST /ui/api/podman-hosts), `hopper machine podman-host` or `hopper config set`. Read at each sandbox, so
// an edit reaches the next one without a restart.
import type { ConfigRecords } from '../domain/ports.ts';
import { PODMAN_HOSTS, podmanHostsOf, podmanHostsProblem, type PodmanHost, type PodmanHostsView } from '../domain/podman-hosts.ts';

/** The hosts now; none while the record is missing. */
export const readPodmanHosts = (config: ConfigRecords): PodmanHost[] => podmanHostsOf(config.read(PODMAN_HOSTS));

export const podmanHostsView = (config: ConfigRecords): PodmanHostsView => ({ hosts: readPodmanHosts(config), version: config.version(PODMAN_HOSTS) });

export type PodmanHostsWrite = { ok: true; view: PodmanHostsView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the hosts with `hosts` if the record is still at `version`. A label left empty is dropped. */
export function writePodmanHosts(config: ConfigRecords, hosts: PodmanHost[], version: string): PodmanHostsWrite {
  const value = { hosts: hosts.map(({ label, ...h }) => ({ ...h, ...(label?.trim() ? { label: label.trim() } : {}) })) };
  const problem = podmanHostsProblem(value);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(PODMAN_HOSTS, value, version)) return { ok: false, code: 'conflict', error: 'the Podman hosts changed since they were read; reload and edit again' };
  return { ok: true, view: podmanHostsView(config) };
}
