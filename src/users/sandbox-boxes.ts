// The sandbox boxes a user's machines name (issue #603): the boxes the hopper keeps for that user.
import type { PluginHost } from '../plugins/host-types.ts';

/**
 * The `container` of each client target the plugins config names now. Undefined while the plugins config cannot be
 * read: nothing is removed on a config that cannot say which machines there are (a box holds an agent's sign-in).
 */
export function sandboxBoxesOf(host: Pick<PluginHost, 'report' | 'targets'>): Set<string> | undefined {
  const { config } = host.report();
  if (config.source === 'defaults' || config.error !== undefined) return undefined;
  return new Set(host.targets().flatMap((m) => ('client' in m && m.client.container ? [m.client.container] : [])));
}
