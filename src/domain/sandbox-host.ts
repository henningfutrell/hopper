// The sandbox host (issue #2272, design.md "The sandbox host"): the machines a user's sandboxes start on, in priority
// order — `local`, the runtime beside the hopper, a machine of the user's with no coding lanes, or a Podman host
// (src/domain/podman-hosts.ts). While it is set, every
// sandbox (a need or box step, a bastion, the read-only check, the warm pass) starts only on the first of them that is
// online, never on another machine; none online, a step waits and says "sandbox host <name> is offline". Not set:
// sandboxes start where they did before (beside the hopper, else a client target dialled in). Kept in the user's settings
// (`sandboxHost`); a change applies to the next sandbox, and a sandbox that runs already ends where it started. Pure.
import type { ActingPerson } from './failures.ts';

/** The most machines the sandbox host names. */
export const SANDBOX_HOSTS_MOST = 5;

/** The sandbox host as the user's settings keep it: the machines, first first, and who set it, the way, and when. */
export interface SandboxHost extends ActingPerson { hosts: string[]; at: string }

/** A machine's place in the sandbox host (issue #2272), as its snapshot carries it: 1 is the first. Absent: not a sandbox host. */
export interface MachineSandboxHost { sandboxHost?: number }

/** The machines with each one of the sandbox host marked with its place. */
export const withSandboxHost = <M extends { id: string }>(machines: readonly M[], hosts: readonly string[]): (M & MachineSandboxHost)[] =>
  machines.map((m) => { const at = hosts.indexOf(m.id); return at < 0 ? m : { ...m, sandboxHost: at + 1 }; });

/** What a step says while no machine of the sandbox host is online: it waits, and never starts on another machine. */
export const sandboxHostOffline = (hosts: readonly string[]): string =>
  hosts.length === 1 ? `sandbox host ${hosts[0]} is offline` : `sandbox hosts ${hosts.join(', ')} are offline`;

/**
 * Why `hosts` cannot be the sandbox host; undefined: it can. `machines`: the user's machines now, with their lanes; a
 * machine not listed is known when `known` says so (one in the config that is not polled now). `podmanHosts`: the names
 * of the user's Podman hosts, which run no coding lane.
 */
export function sandboxHostProblem(hosts: readonly string[], machines: readonly { id: string; maxLanes: number }[], known: (id: string) => boolean, podmanHosts: readonly string[] = []): string | undefined {
  if (hosts.length > SANDBOX_HOSTS_MOST) return `the sandbox host names at most ${SANDBOX_HOSTS_MOST} machines`;
  if (new Set(hosts).size !== hosts.length) return 'the sandbox host names a machine twice';
  for (const id of hosts) {
    if (id === 'local') continue;
    const podman = podmanHosts.includes(id);
    if (podman && (known(id) || machines.some((x) => x.id === id))) return `${id} names both a machine and a Podman host: rename the Podman host`;
    if (podman) continue;
    const m = machines.find((x) => x.id === id);
    if (!m && !known(id)) return `machine ${id} not found`;
    // Issue #2272: a coding lane never runs a sandbox, so no minted credential reaches a worker seat.
    if (m && m.maxLanes > 0) return `machine ${id} runs coding lanes: a sandbox host runs none. Set its lanes to 0 first`;
  }
  return undefined;
}
