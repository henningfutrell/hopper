// The links of the machines dialled in to this hopper (design.md "Joining a machine", issue #308): one
// socket per machine key per user, the one its client dialled in on (src/http/client-link.ts). A client
// that dials in again replaces its old link; a link that ends is forgotten. What goes down a link is the
// hopper's HTTP/2 calls (src/executors/client.ts); this only keeps the sockets.
import type { Duplex } from 'node:stream';

export interface MachineLinks {
  /** A machine's new link: an older one of the same machine is closed. */
  accept(user: string, key: string, socket: Duplex): void;
  /** The machine's link now; undefined while it is not dialled in. */
  link(user: string, key: string): Duplex | undefined;
  /** When the machine last dialled in (ms since the epoch); 0: never since this daemon started. */
  dialledAt(user: string, key: string): number;
  /** Closes every link (the daemon stops). */
  closeAll(): void;
}

export function createMachineLinks(): MachineLinks {
  const links = new Map<string, Duplex>();
  const at = new Map<string, number>();
  const id = (user: string, key: string): string => `${user}\0${key}`;
  return {
    accept(user, key, socket) {
      const k = id(user, key);
      const old = links.get(k);
      links.set(k, socket);
      at.set(k, Date.now());
      old?.destroy();
      socket.once('close', () => { if (links.get(k) === socket) links.delete(k); });
    },
    link: (user, key) => links.get(id(user, key)),
    dialledAt: (user, key) => at.get(id(user, key)) ?? 0,
    closeAll() {
      for (const s of links.values()) s.destroy();
      links.clear();
    },
  };
}
