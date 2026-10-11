// The sandbox boxes a user's machines name (issue #603): the boxes the hopper keeps for that user; and a user's client
// targets, as the sandbox module starts a box on one (issue #708).
import { runtimeRelay } from '../executors/client.ts';
import type { PluginHost } from '../plugins/host-types.ts';
import type { ClientTargets } from '../sandbox/runtime.ts';
import type { UserMachineLink } from './runtime.ts';

/**
 * The `container` of each client target the plugins config names now. Undefined while the plugins config cannot be
 * read: nothing is removed on a config that cannot say which machines there are (a box holds an agent's sign-in).
 */
export function sandboxBoxesOf(host: Pick<PluginHost, 'report' | 'targets'>): Set<string> | undefined {
  const { config } = host.report();
  if (config.source === 'defaults' || config.error !== undefined) return undefined;
  return new Set(host.targets().flatMap((m) => ('client' in m && m.client.container ? [m.client.container] : [])));
}

/** The boxes each user's machines name: none for a user the instance no longer has; all kept for one whose runtime cannot say now. */
export const sandboxBoxesFor = (instance: { users: { get(id: string): unknown } }, runtimes: { get(id: string): { host: Pick<PluginHost, 'report' | 'targets'> } | undefined }) =>
  (userId: string): Set<string> | undefined => {
    if (!instance.users.get(userId)) return new Set();
    const rt = runtimes.get(userId);
    return rt ? sandboxBoxesOf(rt.host) : undefined;
  };

/** A user's client target by name (issue #708): its runtime calls go through its client; a box there dials the hopper where the machine did. */
export const sandboxClientsOf = (runtimes: { get(id: string): { machineLink: Pick<UserMachineLink, 'client'> } | undefined }): ClientTargets => (userId, machine) => {
  const link = runtimes.get(userId)?.machineLink.client;
  const t = link?.named(machine);
  return t && link && { relay: runtimeRelay(t), dialled: () => link.dialled(machine) };
};
