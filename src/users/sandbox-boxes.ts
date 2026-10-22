// A user's client targets, as the sandbox module runs a need step, a read-only check or a burn on one (issue #708).
import { runtimeRelay } from '../executors/client.ts';
import type { ClientTargets } from '../sandbox/runtime.ts';
import type { RuntimeSocket } from '../sandbox/socket-http.ts';
import type { UserMachineLink } from './runtime.ts';

type Runtime = { user: { id: string }; machineLink: Pick<UserMachineLink, 'client'> };

/**
 * A user's client target by name (issue #708): its runtime calls go through its client. And the names of those dialled
 * in now, where a read-only check can run; and every user's, where the sweeps burn what a box left; and whether one is
 * there at all, dialled in or not (issue #1349).
 */
export const sandboxClientsOf = (runtimes: { get(id: string): Runtime | undefined; all(): Runtime[] }): ClientTargets => Object.assign(
  (userId: string, machine: string) => {
    const t = runtimes.get(userId)?.machineLink.client.named(machine);
    return t && { relay: runtimeRelay(t) };
  },
  {
    dialledIn: (userId: string) => runtimes.get(userId)?.machineLink.client.dialledIn() ?? [],
    allDialledIn: () => runtimes.all().flatMap((rt) => rt.machineLink.client.dialledIn().map((machine) => ({ userId: rt.user.id, machine }))),
    known: (userId: string, machine: string) => runtimes.get(userId)?.machineLink.client.named(machine) !== undefined,
  },
);

type HostsRuntime = { user: { id: string }; engine: { sandboxHost: { hosts(): readonly string[] } }; podmanHostSocket(name: string): RuntimeSocket | undefined };

/**
 * Every user's Podman hosts in use (issue #2272): each one the user's sandbox host names, or an open sandbox run of theirs
 * names, with its ssh stream. What the remote box meter reads.
 */
export const podmanHostsInUse = (runtimes: { all(): HostsRuntime[] }, open: () => readonly { userId: string; machine: string }[]) => (): { userId: string; name: string; socket: RuntimeSocket }[] =>
  runtimes.all().flatMap((rt) => {
    const names = new Set([...rt.engine.sandboxHost.hosts(), ...open().filter((r) => r.userId === rt.user.id).map((r) => r.machine)]);
    return [...names].flatMap((name) => {
      const socket = rt.podmanHostSocket(name);
      return socket ? [{ userId: rt.user.id, name, socket }] : [];
    });
  });
