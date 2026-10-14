// The address a box beside the hopper dials (issue #708): set when the box is made, from what the runtime says of the
// hopper itself, never guessed after. On the host network, the hopper's loopback. In a container on the box's network,
// a name the hopper answers to there that is also one of its LAN names: the box resolves it, and the hopper takes it
// as a Host. The box's start check (flags.ts) then proves it from inside the box before the launch answers.
import { hostname } from 'node:os';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import { LaunchRefused } from './launch.ts';

export interface HopperSelf {
  runtime: ContainerRuntime;
  /** The network the box joins. */
  network: string;
  /** The hopper's own container, as the runtime names it (its hostname); undefined: the hopper runs on the host. */
  self: string | undefined;
  /** HOPPER_LAN_NAMES: the Hosts the hopper takes from the LAN. */
  lanNames: readonly string[];
  port: number;
}

/** The hopper's own container: in a container, its hostname is its id; a hopper on the host has none. */
export const ownContainer = (localMachine: boolean): string | undefined => (localMachine ? undefined : hostname());

/** The hopper's URL from the box's network. Throws LaunchRefused (409) when a box there could not reach it. */
export async function hopperAddress(o: HopperSelf): Promise<string> {
  if (o.network === 'host') return `http://127.0.0.1:${o.port}`;
  const me = o.self === undefined ? undefined : await o.runtime.inspect(o.self);
  // No container of this runtime: the hopper's first LAN name, which only the start check can prove.
  if (!me) return `http://${o.lanNames[0] ?? 'hopper'}:${o.port}`;
  const names = me.networks?.[o.network];
  if (!names) throw new LaunchRefused(409, `the hopper's container is not on the network ${o.network}, where a box starts: a box there could not reach it. Join it: podman network connect ${o.network} ${me.name}`);
  const name = o.lanNames.find((n) => names.includes(n));
  if (!name) throw new LaunchRefused(409, `on the network ${o.network} the hopper answers to ${names.join(', ')}, and HOPPER_LAN_NAMES (${o.lanNames.join(', ')}) names none of them: a box there could not reach it. Add ${names[0] ?? 'its name there'} to HOPPER_LAN_NAMES`);
  return `http://${name}:${o.port}`;
}
