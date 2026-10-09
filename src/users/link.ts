// A user's link with their machines (issue #308, design.md "Joining a machine"): the hopper's link key for this
// user — minted once and kept in the user's store, like the hopper's own ssh key; its public half is what a joining
// machine is given —, a client target reached down its link with the token derived from that key and its machine
// key, and where a client target dialled in, which is where its jobs reach the hopper (issue #563).
import type { ClientTransport } from '../executors/client.ts';
import { linkToken, mintLinkKey, type LinkKey } from '../client/link.ts';
import type { UserStore } from '../domain/ports.ts';
import type { AttachedMachine } from '../domain/types.ts';
import type { MachineLinks } from '../machines/links.ts';

export interface UserLink {
  key: LinkKey;
  /** The client target `machine` with machine key `key`, reached down its link. */
  transport(machine: string, key: string): ClientTransport;
  /** The client target named `machine` now, reached down its link; undefined when none is. */
  named(machine: string): ClientTransport | undefined;
  /** The hopper's URL as the client target named `machine` dialled it; undefined for any other machine. */
  dialled(machine: string): string | undefined;
}

export function createUserLink(o: { store: UserStore; links: MachineLinks; userId: string; targets: () => AttachedMachine[] }): UserLink {
  let stored = o.store.settings.getLinkKey();
  if (!stored) { stored = mintLinkKey(); o.store.settings.setLinkKey(stored); }
  const key = stored;
  const transport = (machine: string, machineKey: string): ClientTransport => ({
    machine, link: () => o.links.link(o.userId, machineKey), token: () => linkToken(key.privateKey, machineKey),
  });
  const client = (machine: string) => {
    const m = o.targets().find((t) => t.name === machine);
    return m && 'client' in m ? m : undefined;
  };
  return {
    key, transport,
    named: (machine) => { const m = client(machine); return m && transport(m.name, m.client.key); },
    dialled: (machine) => { const m = client(machine); return m && o.links.urlOf(o.userId, m.client.key); },
  };
}
